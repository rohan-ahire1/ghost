import { createAgentActivity } from "./linear.js";
import type { LinearTokenManager } from "./linear.js";
import { JobStore, type JobRecord } from "./jobStore.js";
import { resolveRepository, buildBranchName } from "./repoResolver.js";
import { runMuse, parseMuseJsonl } from "./museRunner.js";
import { extractDirective, isQuickQuestion } from "./intent.js";
import { runCommand, sanitizeError } from "./commandRunner.js";
import type { GhostJobContext, PipelineDeps } from "./sessionTypes.js";
import { postActivity, sendElicitation } from "./activities.js";
import { runScratchPipeline, runRepoPipeline, cleanupWorktreeAndBranch, getDataDir, getWorktreesDir } from "./pipeline.js";
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

  console.log(
    JSON.stringify({
      msg: "Ghost job started",
      agentSessionId: ctx.agentSessionId,
      issueIdentifier: ctx.issueIdentifier,
      issueTitle: ctx.issueTitle,
    }),
  );

  const jobStore = new JobStore(dataDir);
  const worktreesDir = getWorktreesDir(dataDir);

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
      await drainPendingTurns({ agentSessionId: ctx.agentSessionId, dataDir, jobStore, tokenManager, runner, fetchFn, createActivityFn, museRunner });
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

  // Phase 1: immediate ack within 10s
  try {
    const ackBody = ctx.issueIdentifier
      ? `👋 Ghost received **${ctx.issueIdentifier}**${ctx.issueTitle ? ` — "${ctx.issueTitle}"` : ""} and is working on it…`
      : "👋 Ghost received your message and is working on it…";
    const ackDetail =
      `_promptContext ${ctx.promptContext ? `${ctx.promptContext.length} chars` : "present"} · session \`${ctx.agentSessionId}\`_\n` +
      `I'll post the result here when the work finishes.`;
    const ackOk = await postActivity(tokenManager, ctx.agentSessionId, { type: "thought", body: `${ackBody}\n\n${ackDetail}` }, createActivityFn);
    if (ackOk) console.log(JSON.stringify({ msg: "Ghost ack (working) sent", agentSessionId: ctx.agentSessionId }));
  } catch (err) {
    console.error(JSON.stringify({ msg: "Ghost ack error", agentSessionId: ctx.agentSessionId, error: sanitizeError((err as Error).message, 300) }));
  }

  // Mark running
  await jobStore.withSessionLock(ctx.agentSessionId, async () => {
    const rec = jobStore.load(ctx.agentSessionId);
    if (rec) {
      rec.status = "running";
      jobStore.save(rec);
    }
  });

  // Step: Resolve repository. Zero or multiple matches are NOT a failure and
  // never stop the request before Muse: the request still runs exactly once in
  // a private per-session scratch workspace with candidate information in the
  // Muse prompt. Muse answers directly when no change is needed, or returns
  // blocked asking for the target repository when edits are required. Only a
  // single resolved repo continues in an isolated git worktree.
  let repoResult: ReturnType<typeof resolveRepository> | null = null;
  try {
    repoResult = resolveRepository({
      issueIdentifier: ctx.issueIdentifier,
      issueTitle: ctx.issueTitle,
      promptContext: ctx.promptContext,
      rawPayload: ctx.rawPayload,
    });
  } catch (err) {
    const msg = sanitizeError((err as Error).message, 400);
    console.error(JSON.stringify({ msg: "repo resolver error", error: msg }));
    await jobStore.withSessionLock(ctx.agentSessionId, async () => {
      const rec = jobStore.load(ctx.agentSessionId);
      if (rec) {
        rec.status = "failed";
        rec.error = msg.slice(0, 500);
        jobStore.save(rec);
      }
    });
    await postActivity(tokenManager, ctx.agentSessionId, { type: "error", body: `Ghost failed to resolve repository: ${msg}` }, createActivityFn);
    return;
  }

  const quickQuestion = isQuickQuestion(directive);

  if (!repoResult.repo || quickQuestion) {
    // Zero or multiple matches — run in a private per-session scratch
    // workspace so every request still reaches Muse exactly once. Candidate
    // information goes into the Muse prompt (e.g. cross-repo summaries work);
    // when edits genuinely need a repository, Muse returns blocked asking for
    // the target repo, which then sends the Linear elicitation. Never fail or
    // elicit early here.
    const candidates = quickQuestion && repoResult.repo
      ? [repoResult.repo.id]
      : repoResult.candidates.map((c) => c.id);
    const resolutionKind = quickQuestion
      ? "quick question"
      : candidates.length > 1 ? "multiple repos matched" : "no repo matched";
    console.log(JSON.stringify({ msg: `${resolutionKind}, using scratch workspace`, reason: repoResult.reason, candidates, sessionId: ctx.agentSessionId }));
    await jobStore.withSessionLock(ctx.agentSessionId, async () => {
      const rec = jobStore.load(ctx.agentSessionId);
      if (rec) {
        rec.workspaceKind = "scratch";
        jobStore.save(rec);
      }
    });
    const scratchNote = quickQuestion
      ? "💬 Quick question — answering directly with no worktree (nothing to commit)"
      : candidates.length > 1
        ? `🔍 Multiple repositories matched (${candidates.join(", ")}) — working in a private scratch workspace so the request still gets answered (no commits will be made)`
        : `🔍 No repository matched — working in a private scratch workspace (no commits will be made)`;
    await postActivity(tokenManager, ctx.agentSessionId, { type: "thought", body: scratchNote }, createActivityFn);
    try {
      await runScratchPipeline({
        ctx,
        dataDir,
        jobStore,
        tokenManager,
        createActivityFn,
        museRunner,
        repoResolution: { candidates, reason: quickQuestion ? "quick question, no worktree needed" : repoResult.reason },
        directive,
      });
    } catch (err) {
      const safe = sanitizeError((err as Error).message, 600);
      console.error(JSON.stringify({ msg: "scratch pipeline error", sessionId: ctx.agentSessionId, error: safe }));
      await jobStore.withSessionLock(ctx.agentSessionId, async () => {
        const rec = jobStore.load(ctx.agentSessionId);
        if (rec && rec.status !== "completed" && rec.status !== "awaiting_input") {
          rec.status = "failed";
          rec.error = safe.slice(0, 800);
          jobStore.save(rec);
        }
      });
      await postActivity(tokenManager, ctx.agentSessionId, { type: "error", body: `Ghost encountered an error: ${safe}` }, createActivityFn);
    }
    // Messages that arrived mid-turn chain behind it in the same session.
    await drainPendingTurns({ agentSessionId: ctx.agentSessionId, dataDir, jobStore, tokenManager, runner, fetchFn, createActivityFn, museRunner });
    return;
  }

  const repo = repoResult.repo;
  const branch = buildBranchName(ctx.issueIdentifier, ctx.agentSessionId);

  console.log(JSON.stringify({ msg: "repo resolved", repo: repo.id, branch, sessionId: ctx.agentSessionId }));

  // Persist repo/branch
  await jobStore.withSessionLock(ctx.agentSessionId, async () => {
    const rec = jobStore.load(ctx.agentSessionId);
    if (rec) {
      rec.repo = { id: repo.id, path: repo.path, github: repo.github };
      rec.branch = branch;
      rec.workspaceKind = "repo";
      jobStore.save(rec);
    }
  });

  await postActivity(tokenManager, ctx.agentSessionId, { type: "thought", body: `🔍 Resolved repository **${repo.id}** (\`${repo.github}\`) · branch \`${branch}\`` }, createActivityFn);

  // No pipeline-wide lock: sessions on the same repo run concurrently in
  // isolated worktrees. Only shared-checkout git ops (setup/cleanup inside
  // runRepoPipeline) take the per-repo lock.
  try {
    await runRepoPipeline({
      ctx,
      repo,
      branch,
      dataDir,
      worktreesDir,
      jobStore,
      tokenManager,
      runner,
      fetchFn,
      createActivityFn,
      museRunner,
      directive,
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
      if (rec?.worktreePath && rec.status === "failed") {
        await cleanupWorktreeAndBranch({ dataDir, worktreePath: rec.worktreePath, targetRepoPath: repo.path, branch, runner, jobStore, repoId: repo.id });
      }
    } catch {}
  }
  // Messages that arrived mid-turn chain behind it in the same session.
  await drainPendingTurns({ agentSessionId: ctx.agentSessionId, dataDir, jobStore, tokenManager, runner, fetchFn, createActivityFn, museRunner });
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
    await drainPendingTurns({ agentSessionId, dataDir, jobStore, tokenManager, runner, fetchFn, createActivityFn, museRunner });
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
