import type { createAgentActivity, LinearTokenManager } from "./linear.js";
import type { JobStore } from "./jobStore.js";
import type { GhostJobContext } from "./sessionTypes.js";
import type { runMuse } from "./museRunner.js";
import type { runChatGate } from "./chat.js";
import { buildHistory } from "./chat.js";
import { runCommand, sanitizeError } from "./commandRunner.js";
import { postActivity } from "./activities.js";
import { runTicketPipeline, cleanupWorktreeAndBranch, ensureScratchWorkspace } from "./pipeline.js";

interface TurnOpts {
  agentSessionId: string;
  dataDir: string;
  jobStore: JobStore;
  tokenManager: LinearTokenManager;
  runner: typeof runCommand;
  fetchFn: typeof fetch;
  createActivityFn: typeof createAgentActivity;
  museRunner: typeof runMuse;
  chatRunner: typeof runChatGate;
}

/**
 * Run exactly one turn for the session's pending (unconsumed) follow-ups.
 * Same shape as a fresh turn: the chat gate sees only the new messages and
 * the ticket id, then either answers or continues to the ticket stage.
 */
async function runResumeTurn(opts: TurnOpts): Promise<void> {
  const { agentSessionId, dataDir, jobStore, tokenManager, runner, fetchFn, createActivityFn, museRunner, chatRunner } = opts;

  const fresh = jobStore.load(agentSessionId);
  if (!fresh) return;
  const allFollowUps = fresh.followUps || [];
  const consumedBefore = fresh.consumedFollowUps || 0;
  const turnInput = allFollowUps.slice(consumedBefore).join("\n");
  if (!turnInput.trim()) return;
  // Consume up front so messages arriving during this turn stay pending for
  // the next chained turn instead of being silently dropped.
  await jobStore.withSessionLock(agentSessionId, async () => {
    const rec = jobStore.load(agentSessionId);
    if (rec) {
      rec.consumedFollowUps = (rec.followUps || []).length;
      rec.status = "running";
      jobStore.save(rec);
    }
  });

  const history = buildHistory(allFollowUps, consumedBefore, fresh.summary);
  const scratchPath = fresh.scratchPath || ensureScratchWorkspace(dataDir, agentSessionId);
  if (!fresh.scratchPath) {
    await jobStore.withSessionLock(agentSessionId, async () => {
      const rec = jobStore.load(agentSessionId);
      if (rec) {
        rec.scratchPath = scratchPath;
        jobStore.save(rec);
      }
    });
  }

  const ctx: GhostJobContext = {
    agentSessionId,
    issueIdentifier: fresh.issueIdentifier,
    issueTitle: fresh.issueTitle,
    promptContext: fresh.promptContext,
    rawPayload: null,
  };
  const message = turnInput.slice(0, 8000);

  let gate: { mode: "chat" | "fetch"; reply: string };
  try {
    gate = await chatRunner({ workspace: scratchPath, ticketId: fresh.issueIdentifier, message, history });
  } catch (err) {
    const safe = sanitizeError((err as Error).message, 600);
    console.error(JSON.stringify({ msg: "resume chat gate error", sessionId: agentSessionId, error: safe }));
    await jobStore.withSessionLock(agentSessionId, async () => {
      const rec = jobStore.load(agentSessionId);
      if (rec) {
        rec.status = "failed";
        rec.error = safe.slice(0, 800);
        jobStore.save(rec);
      }
    });
    await postActivity(tokenManager, agentSessionId, { type: "error", body: `Ghost encountered an error while resuming: ${safe}` }, createActivityFn);
    return;
  }

  if (gate.mode !== "fetch" && gate.reply.trim()) {
    const reply = sanitizeError(gate.reply, 4000);
    await jobStore.withSessionLock(agentSessionId, async () => {
      const rec = jobStore.load(agentSessionId);
      if (rec) {
        rec.status = "completed";
        rec.summary = reply;
        jobStore.save(rec);
      }
    });
    await postActivity(tokenManager, agentSessionId, { type: "response", body: reply }, createActivityFn);
    console.log(JSON.stringify({ msg: "Ghost resume chat turn completed", sessionId: agentSessionId }));
    return;
  }

  await postActivity(
    tokenManager,
    agentSessionId,
    { type: "thought", body: fresh.issueIdentifier ? `📖 Reading **${fresh.issueIdentifier}**…` : "📖 Reading the ticket…" },
    createActivityFn,
  );
  try {
    await runTicketPipeline({
      ctx,
      dataDir,
      jobStore,
      tokenManager,
      runner,
      fetchFn,
      createActivityFn,
      museRunner,
      scratchPath,
      message,
      knownRepo: fresh.repo,
    });
  } catch (err) {
    const safe = sanitizeError((err as Error).message, 600);
    console.error(JSON.stringify({ msg: "resume pipeline error", sessionId: agentSessionId, error: safe }));
    await jobStore.withSessionLock(agentSessionId, async () => {
      const rec = jobStore.load(agentSessionId);
      if (rec && rec.status !== "completed" && rec.status !== "awaiting_input") {
        rec.status = "failed";
        rec.error = safe.slice(0, 800);
        jobStore.save(rec);
      }
    });
    await postActivity(tokenManager, agentSessionId, { type: "error", body: `Ghost encountered an error while resuming: ${safe}` }, createActivityFn);
    // Best-effort cleanup on terminal failed during resume
    try {
      const rec = jobStore.load(agentSessionId);
      if (rec?.worktreePath && rec.status === "failed" && rec.repo) {
        await cleanupWorktreeAndBranch({ dataDir, worktreePath: rec.worktreePath, targetRepoPath: rec.repo.path, branch: rec.branch, runner, jobStore, repoId: rec.repo.id });
      }
    } catch {}
  }
}

/**
 * Pull the user's text out of a webhook payload. Linear uses different fields
 * per event shape (activity body, mentioning comment, top-level text).
 */
export function extractPromptBody(payload: any): unknown {
  // The triggering user message lives at agentActivity.content when its type
  // is `prompt`. Anything else there (thought, response, ...) is an echo of
  // Ghost's own output — never an instruction. NOTE: agentSession.comment is
  // the session-creating mention ("@ghost hi"), i.e. STALE text in follow-up
  // events, so it is only a last resort, never preferred.
  const activityContent =
    payload?.agentActivity?.content ?? payload?.data?.agentActivity?.content;
  if (activityContent && typeof activityContent === "object") {
    if (typeof activityContent.body === "string" && activityContent.body.trim() !== "") {
      if (!activityContent.type || activityContent.type === "prompt") return activityContent.body;
      return ""; // echo of our own activity: nothing new to answer
    }
  }
  // Flat activity body (older event shapes and tests).
  if (typeof payload?.agentActivity?.body === "string" && payload.agentActivity.body.trim() !== "") {
    return payload.agentActivity.body;
  }
  if (typeof payload?.data?.agentActivity?.body === "string" && payload.data.agentActivity.body.trim() !== "") {
    return payload.data.agentActivity.body;
  }
  return (
    payload?.comment?.body ||
    payload?.data?.comment?.body ||
    payload?.data?.body ||
    payload?.body ||
    payload?.text ||
    payload?.data?.text ||
    payload?.prompt ||
    payload?.data?.prompt ||
    payload?.agentSession?.comment?.body ||
    payload?.data?.agentSession?.comment?.body ||
    ""
  );
}

const MAX_CHAINED_TURNS = 10;

/**
 * Run turns until no unanswered messages remain (or the cap hits). A new
 * message in the same chat starts a new turn — including after a previous
 * turn completed, and including messages that arrived mid-turn. The in-flight
 * turn is never interrupted; queued messages chain behind it.
 */
export async function drainPendingTurns(opts: TurnOpts): Promise<void> {
  const { agentSessionId, jobStore } = opts;
  for (let i = 0; i < MAX_CHAINED_TURNS; i++) {
    const rec = jobStore.load(agentSessionId);
    if (!rec) return;
    const pending = (rec.followUps || [])
      .slice(rec.consumedFollowUps || 0)
      .filter((s) => typeof s === "string" && s.trim() !== "");
    if (pending.length === 0) return;
    // Only take over idle jobs; a running turn drains for itself when done.
    if (rec.status !== "awaiting_input" && rec.status !== "completed") return;
    await runResumeTurn(opts);
  }
  const rec = jobStore.load(agentSessionId);
  const pending = (rec?.followUps || []).slice(rec?.consumedFollowUps || 0);
  if (rec && pending.length > 0) {
    await postActivity(opts.tokenManager, agentSessionId, { type: "thought", body: "Still have queued messages after several turns — send a new message to continue." }, opts.createActivityFn);
  }
}
