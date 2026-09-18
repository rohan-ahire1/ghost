import { createAgentActivity } from "./linear.js";
import type { LinearTokenManager } from "./linear.js";
import { JobStore, type JobRecord } from "./jobStore.js";
import { runMuse, parseMuseJsonl } from "./museRunner.js";
import { runChatGate } from "./chat.js";
import { runCommand, sanitizeError } from "./commandRunner.js";
import type { GhostJobContext, PipelineDeps } from "./sessionTypes.js";
import { postActivity, sendElicitation } from "./activities.js";
import { runTicketPipeline, cleanupWorktreeAndBranch, ensureScratchWorkspace, getDataDir } from "./pipeline.js";
import { drainPendingTurns, extractPromptBody } from "./resume.js";

// Compat re-exports for the pre-split module layout.
export { ensureScratchWorkspace } from "./pipeline.js";
export type { GhostJobContext, PipelineDeps } from "./sessionTypes.js";

export function logAgentSessionMetadata(payload: any): void {
  const type = payload?.type;
  const action = payload?.action;
  const agentSessionId =
    payload?.agentSession?.id ||
    payload?.data?.id ||
    payload?.data?.agentSession?.id ||
    payload?.agentSessionId ||
    "unknown";
  const issue =
    payload?.agentSession?.issue ||
    payload?.data?.issue ||
    payload?.issue ||
    null;
  const identifier = issue?.identifier || payload?.promptContext?.match(/identifier="([^"]+)"/)?.[1] || undefined;
  const title = issue?.title || undefined;

  const hasPromptContext = typeof payload?.promptContext === "string";
  const promptContextSnippet = hasPromptContext
    ? `promptContext length=${payload.promptContext.length}`
    : "no promptContext";

  console.log(
    JSON.stringify({
      msg: "AgentSessionEvent",
      type,
      action,
      agentSessionId,
      issueIdentifier: identifier,
      issueTitle: title,
      promptContext: promptContextSnippet,
      webhookTimestamp: payload?.webhookTimestamp,
      webhookId: payload?.webhookId,
    }),
  );
}
/**
 * Extract relevant IDs from webhook payload.
 * Designed to be defensive against schema variations.
 */
export function extractGhostContext(payload: any): GhostJobContext | null {
  const agentSessionId =
    payload?.agentSession?.id ||
    payload?.data?.id ||
    payload?.data?.agentSession?.id ||
    payload?.agentSessionId ||
    null;

  if (!agentSessionId) {
    console.error("[ghost] AgentSessionEvent missing agentSession.id, cannot start job");
    return null;
  }

  const promptContext: string | undefined =
    typeof payload?.promptContext === "string"
      ? payload.promptContext
      : typeof payload?.data?.promptContext === "string"
        ? payload.data.promptContext
        : undefined;

  // A created session caused by an @mention includes the comment that
  // triggered it. Do not infer the user's present intent from promptContext:
  // it deliberately includes the whole issue, prior comments, and guidance.
  // Delegations commonly have no comment, in which case the issue itself is
  // the task and initialPrompt remains undefined.
  const initialPromptCandidates = [
    payload?.agentSession?.comment?.body,
    payload?.data?.agentSession?.comment?.body,
    payload?.comment?.body,
    payload?.data?.comment?.body,
  ];
  const initialPrompt = initialPromptCandidates.find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );

  const issue =
    payload?.agentSession?.issue ||
    payload?.data?.issue ||
    payload?.issue ||
    null;

  let issueIdentifier: string | undefined = issue?.identifier;
  if (!issueIdentifier && typeof promptContext === "string") {
    const m = promptContext.match(/<issue[^>]*identifier="([^"]+)"/);
    if (m) issueIdentifier = m[1];
  }
  const issueTitle: string | undefined = issue?.title;

  return {
    agentSessionId,
    promptContext,
    initialPrompt,
    issueIdentifier,
    issueTitle,
    rawPayload: payload,
  };
}

/**
 * Extract the user's actual triggering message from a webhook payload and/or
 * promptContext. Linear always delivers the FULL issue body as promptContext;
 * the user's message arrives as `initialPrompt` or in the mentioning comment.
 * Returns undefined when nothing directive-like is found.
 */
export function extractDirective(rawPayload: any, promptContext?: string): string | undefined {
  const candidates: unknown[] = [
    rawPayload?.agentSession?.comment?.body,
    rawPayload?.data?.agentSession?.comment?.body,
    rawPayload?.comment?.body,
    rawPayload?.data?.comment?.body,
    rawPayload?.agentActivity?.body,
    rawPayload?.data?.agentActivity?.body,
    rawPayload?.prompt,
    rawPayload?.data?.prompt,
    rawPayload?.text,
    rawPayload?.data?.text,
  ];
  for (const c of candidates) {
    const cleaned = cleanDirective(typeof c === "string" ? c : undefined);
    if (cleaned) return cleaned;
  }
  if (typeof promptContext === "string") {
    // Linear embeds the mentioning comment first:
    // <primary-directive-thread><comment ...>TEXT</comment>...
    const m = promptContext.match(/<primary-directive-thread[^>]*>[\s\S]*?<comment[^>]*>([\s\S]*?)<\/comment>/i);
    const cleaned = cleanDirective(m?.[1]);
    if (cleaned) return cleaned;
  }
  return undefined;
}

function cleanDirective(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = raw
    // Strip Linear mention tags like <user id="...">ghost</user>
    .replace(/<user[^>]*>[\s\S]*?<\/user>/gi, " ")
    // Strip any other XML-ish framing tags but keep inner text
    .replace(/<\/?(comment|primary-directive-thread|other-thread|issue|title|description|team|project|issue-relations|issue-ref|blocking|related)[^>]*>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 2) return undefined;
  // A bare "@ghost" mention with nothing else carries no directive
  if (/^@?ghost$/i.test(text)) return undefined;
  if (text.length > 2000) return text.slice(0, 2000);
  return text;
}

/**
 * Greeting sessions stay open for a follow-up. The fallback recognizes the
 * short-lived records written by the previous release so they do not keep
 * replaying a terminal `already completed` response forever.
 */
function isConversationOnlyJob(job: JobRecord): boolean {
  if (job.interactionMode === "conversation") return true;
  return !job.repo && !job.branch && !job.worktreePath && !job.scratchPath &&
    /^hey\s*[—-]\s*i[’']m here\b/i.test(job.summary || "");
}

// Main pipeline for created
export async function handleAgentSessionCreated(
  ctx: GhostJobContext,
  tokenManager: LinearTokenManager,
  deps: PipelineDeps = {},
): Promise<void> {
  const dataDir = deps.dataDir || getDataDir();
  const runner = deps.runner || runCommand;
  const fetchFn = deps.fetchFn || fetch;
  const createActivityFn = deps.createActivity || createAgentActivity;
  const museRunner = deps.museRunner || runMuse;
  const chatRunner = deps.chatRunner || runChatGate;

  console.log(
    JSON.stringify({
      msg: "Ghost job started",
      agentSessionId: ctx.agentSessionId,
      issueIdentifier: ctx.issueIdentifier,
      issueTitle: ctx.issueTitle,
    }),
  );

  const jobStore = new JobStore(dataDir);

  // Per-session lock for duplicate check & creation
  let isDuplicate = false;
  let existingStatus: string | undefined;

  await jobStore.withSessionLock(ctx.agentSessionId, async () => {
    const existing = jobStore.load(ctx.agentSessionId);
    if (existing) {
      isDuplicate = true;
      existingStatus = existing.status;
      return;
    }
    // Create initial record
    const rec: JobRecord = {
      sessionId: ctx.agentSessionId,
      status: "created",
      issueIdentifier: ctx.issueIdentifier,
      issueTitle: ctx.issueTitle,
      promptContext: ctx.promptContext?.slice(0, 20000),
      followUps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const created = jobStore.create(rec);
    if (!created) {
      isDuplicate = true;
      const e = jobStore.load(ctx.agentSessionId);
      existingStatus = e?.status;
    }
  });

  if (isDuplicate) {
    console.log(JSON.stringify({ msg: "duplicate created delivery, ignoring", sessionId: ctx.agentSessionId, status: existingStatus }));
    // A redelivered creation can still carry a new message — store it in the
    // same chat instead of dropping it, and run a turn when the job is idle.
    const dupBody = extractPromptBody(ctx.rawPayload);
    const dupText = typeof dupBody === "string" ? dupBody.slice(0, 8000) : "";
    if (dupText.trim()) {
      await jobStore.withSessionLock(ctx.agentSessionId, async () => {
        const rec = jobStore.load(ctx.agentSessionId);
        if (rec) {
          rec.followUps.push(dupText);
          jobStore.save(rec);
        }
      });
    }
    const dupJob = jobStore.load(ctx.agentSessionId);
    if (dupText.trim() && dupJob && (dupJob.status === "awaiting_input" || dupJob.status === "completed")) {
      await drainPendingTurns({ agentSessionId: ctx.agentSessionId, dataDir, jobStore, tokenManager, runner, fetchFn, createActivityFn, museRunner, chatRunner });
      return;
    }
    // Truthful response without duplicating execution
    const token = await tokenManager.getAuthHeader();
    if (token) {
      const body =
        existingStatus === "running"
          ? `Ghost is already working on \`${ctx.agentSessionId}\` (status: running). Your request is queued.`
          : existingStatus === "awaiting_input"
            ? `Ghost is awaiting input for \`${ctx.agentSessionId}\`. Please respond to the previous question.`
            : existingStatus === "completed"
              ? `Ghost already completed \`${ctx.agentSessionId}\`. No further action taken.`
              : existingStatus === "failed"
                ? `Ghost previously failed for \`${ctx.agentSessionId}\`. See previous error.`
                : `Ghost already received \`${ctx.agentSessionId}\` (status: ${existingStatus || "unknown"}).`;
      await createActivityFn({
        authHeader: token,
        agentSessionId: ctx.agentSessionId,
        content: { type: "thought", body },
      });
    }
    return;
  }

  // The user's message is the instruction — the attached issue history is
  // background, never orders. With no user text there is nothing to do: stay
  // open and ask instead of dispatching the issue.
  const directive = ctx.initialPrompt || extractDirective(ctx.rawPayload, ctx.promptContext);
  if (!directive || !directive.trim()) {
    // `response` makes Linear mark the session complete. No instruction yet:
    // it is an invitation for the user to provide one.
    await jobStore.withSessionLock(ctx.agentSessionId, async () => {
      const rec = jobStore.load(ctx.agentSessionId);
      if (rec) {
        rec.status = "awaiting_input";
        rec.interactionMode = "conversation";
        rec.changedFiles = [];
        jobStore.save(rec);
      }
    });
    await sendElicitation(tokenManager, ctx.agentSessionId, "Ghost is here. Send a message with the task you want me to take on.", createActivityFn);
    console.log(JSON.stringify({ msg: "created without user text, awaiting instruction", sessionId: ctx.agentSessionId }));
    return;
  }
  // Mark running
  await jobStore.withSessionLock(ctx.agentSessionId, async () => {
    const rec = jobStore.load(ctx.agentSessionId);
    if (rec) {
      rec.status = "running";
      jobStore.save(rec);
    }
  });

  // Chat gate first: the model sees ONLY the message and the ticket id —
  // never the ticket body. Small talk answers here with no worktree and no
  // announcement; anything needing the ticket continues to the ticket stage.
  const scratchPath = ensureScratchWorkspace(dataDir, ctx.agentSessionId);
  await jobStore.withSessionLock(ctx.agentSessionId, async () => {
    const rec = jobStore.load(ctx.agentSessionId);
    if (rec) {
      rec.scratchPath = scratchPath;
      rec.workspaceKind = "scratch";
      jobStore.save(rec);
    }
  });

  let gate: { mode: "chat" | "fetch"; reply: string };
  try {
    gate = await chatRunner({
      workspace: scratchPath,
      ticketId: ctx.issueIdentifier,
      message: directive,
      history: [],
    });
  } catch (err) {
    const safe = sanitizeError((err as Error).message, 600);
    console.error(JSON.stringify({ msg: "chat gate error", sessionId: ctx.agentSessionId, error: safe }));
    await jobStore.withSessionLock(ctx.agentSessionId, async () => {
      const rec = jobStore.load(ctx.agentSessionId);
      if (rec) {
        rec.status = "failed";
        rec.error = safe.slice(0, 800);
        jobStore.save(rec);
      }
    });
    await postActivity(tokenManager, ctx.agentSessionId, { type: "error", body: `Ghost encountered an error: ${safe}` }, createActivityFn);
    return;
  }

  if (gate.mode !== "fetch" && gate.reply.trim()) {
    const reply = sanitizeError(gate.reply, 4000);
    await jobStore.withSessionLock(ctx.agentSessionId, async () => {
      const rec = jobStore.load(ctx.agentSessionId);
      if (rec) {
        rec.status = "completed";
        rec.summary = reply;
        jobStore.save(rec);
      }
    });
    await postActivity(tokenManager, ctx.agentSessionId, { type: "response", body: reply }, createActivityFn);
    console.log(JSON.stringify({ msg: "Ghost chat turn completed", sessionId: ctx.agentSessionId }));
    await drainPendingTurns({ agentSessionId: ctx.agentSessionId, dataDir, jobStore, tokenManager, runner, fetchFn, createActivityFn, museRunner, chatRunner });
    return;
  }

  // Fetch path: the message needs the ticket. One short status line, then the
  // ticket stage (answer from the ticket, or repo work when the model says so).
  await postActivity(
    tokenManager,
    ctx.agentSessionId,
    { type: "thought", body: ctx.issueIdentifier ? `📖 Reading **${ctx.issueIdentifier}**…` : "📖 Reading the ticket…" },
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
      message: directive,
    });
  } catch (err) {
    const safe = sanitizeError((err as Error).message, 600);
    console.error(JSON.stringify({ msg: "pipeline error", sessionId: ctx.agentSessionId, error: safe }));
    await jobStore.withSessionLock(ctx.agentSessionId, async () => {
      const rec = jobStore.load(ctx.agentSessionId);
      if (rec && rec.status !== "completed" && rec.status !== "awaiting_input") {
        rec.status = "failed";
        rec.error = safe.slice(0, 800);
        jobStore.save(rec);
      }
    });
    await postActivity(tokenManager, ctx.agentSessionId, { type: "error", body: `Ghost encountered an error: ${safe}` }, createActivityFn);
    // Best-effort cleanup on terminal failed — try to clean isolated worktree if it was created
    try {
      const rec = jobStore.load(ctx.agentSessionId);
      if (rec?.worktreePath && rec.status === "failed" && rec.repo) {
        await cleanupWorktreeAndBranch({ dataDir, worktreePath: rec.worktreePath, targetRepoPath: rec.repo.path, branch: rec.branch, runner, jobStore, repoId: rec.repo.id });
      }
    } catch {}
  }
  // Messages that arrived mid-turn chain behind it in the same session.
  await drainPendingTurns({ agentSessionId: ctx.agentSessionId, dataDir, jobStore, tokenManager, runner, fetchFn, createActivityFn, museRunner, chatRunner });
}

export async function handleAgentSessionPrompted(
  payload: any,
  tokenManager: LinearTokenManager,
  deps: PipelineDeps = {},
): Promise<void> {
  const agentSessionId =
    payload?.agentSession?.id ||
    payload?.data?.id ||
    payload?.agentSessionId ||
    null;
  if (!agentSessionId) return;

  // Linear delivers the user's text under different fields depending on the
  // event shape (activity body, mentioning comment, or top-level text). Check
  // them all before concluding the event carries no user text.
  const promptBody = extractPromptBody(payload);

  console.log(
    JSON.stringify({
      msg: "AgentSession prompted",
      agentSessionId,
      bodyLength: typeof promptBody === "string" ? promptBody.length : 0,
    }),
  );

  const dataDir = deps.dataDir || getDataDir();
  const runner = deps.runner || runCommand;
  const fetchFn = deps.fetchFn || fetch;
  const createActivityFn = deps.createActivity || createAgentActivity;
  const museRunner = deps.museRunner || runMuse;
  const chatRunner = deps.chatRunner || runChatGate;

  const jobStore = new JobStore(dataDir);
  const job = jobStore.load(agentSessionId);

  if (!job) {
    const token = await tokenManager.getAuthHeader();
    if (token) {
      await createActivityFn({
        authHeader: token,
        agentSessionId,
        content: { type: "response", body: "Ghost has no record for this session. Please create a new task." },
      });
    }
    return;
  }

  // Truncate follow-up safely without logging full body
  const followUp = typeof promptBody === "string" ? promptBody.slice(0, 8000) : "";

  // Linear emits prompted events that carry no user text (empty body), e.g.
  // echoes of Ghost's own activities. There is nothing to answer and nothing
  // new to resume with: acting on them re-runs the pipeline on stale context.
  if (!followUp.trim()) {
    console.log(JSON.stringify({ msg: "prompted event without user text, ignoring", agentSessionId }));
    return;
  }

  // Every message joins the same chat in the same session: store it first,
  // then act on the job's status below. Messages arriving mid-turn stay
  // queued and are picked up by the next chained turn when the current one
  // finishes — the current operation is never interrupted.
  await jobStore.withSessionLock(agentSessionId, async () => {
    const rec = jobStore.load(agentSessionId);
    if (rec) {
      rec.followUps.push(followUp);
      jobStore.save(rec);
    }
  });

  // Sessions that never entered the pipeline (created without user text, or by
  // a prior release) rejoin the standard resume path below.
  const current = jobStore.load(agentSessionId);
  if (current && isConversationOnlyJob(current) && current.status !== "running") {
    await jobStore.withSessionLock(agentSessionId, async () => {
      const rec = jobStore.load(agentSessionId);
      if (rec) {
        rec.status = "awaiting_input";
        rec.interactionMode = undefined;
        jobStore.save(rec);
      }
    });
    job.status = "awaiting_input";
  }

  if (job.status === "awaiting_input" || job.status === "completed") {
    // A new message in the same chat starts a new turn — including after a
    // previous turn completed. Queued messages chain via drainPendingTurns.
    await drainPendingTurns({ agentSessionId, dataDir, jobStore, tokenManager, runner, fetchFn, createActivityFn, museRunner, chatRunner });
    return;
  }

  if (job.status === "running") {
    const token = await tokenManager.getAuthHeader();
    if (token) {
      await createActivityFn({
        authHeader: token,
        agentSessionId,
        content: {
          type: "thought",
          body: `Ghost is still working on this task (status: running). Your follow-up (${followUp.length} chars) is queued in this same session — it will be addressed when the current turn finishes.`,
        },
      });
    }
    return;
  }

  if (job.status === "failed") {
    const token = await tokenManager.getAuthHeader();
    if (token) {
      await createActivityFn({
        authHeader: token,
        agentSessionId,
        content: {
          type: "response",
          body: `Ghost previously failed for this task: ${job.error?.slice(0, 500) || "unknown error"}\n\nYou can create a new session to retry.`,
        },
      });
    }
    return;
  }

  if (job.status === "created") {
    // Already stored above; the created pipeline picks it up and drains the
    // queue when its first turn finishes.
    const token = await tokenManager.getAuthHeader();
    if (token) {
      await createActivityFn({
        authHeader: token,
        agentSessionId,
        content: { type: "thought", body: "Ghost received your follow-up while still initializing. It will be processed." },
      });
    }
    return;
  }

  // Fallback
  const token = await tokenManager.getAuthHeader();
  if (token) {
    await createActivityFn({
      authHeader: token,
      agentSessionId,
      content: { type: "response", body: `Ghost received your follow-up (status: ${job.status}).` },
    });
  }
}

// Export for tests: parse helper re-export
export { parseMuseJsonl };
