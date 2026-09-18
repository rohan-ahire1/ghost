import type { createAgentActivity, LinearTokenManager } from "./linear.js";
import type { JobStore } from "./jobStore.js";
import type { GhostJobContext } from "./sessionTypes.js";
import type { runMuse } from "./museRunner.js";
import { resolveRepository, buildBranchName } from "./repoResolver.js";
import { isQuickQuestion } from "./intent.js";
import { runCommand, sanitizeError } from "./commandRunner.js";
import { postActivity } from "./activities.js";
import { runScratchPipeline, runRepoPipeline, cleanupWorktreeAndBranch, getWorktreesDir } from "./pipeline.js";

/**
 * Run exactly one pipeline turn for the session's pending (unconsumed)
 * follow-ups, in the stored or re-resolved workspace. The turn's instruction
 * is only the new messages; older context stays background. Smalltalk never
 * escalates to a worktree: without a code-change request the turn runs in
 * scratch even when the job already has a repository.
 */
async function runResumeTurn(opts: {
  agentSessionId: string;
  dataDir: string;
  jobStore: JobStore;
  tokenManager: LinearTokenManager;
  runner: typeof runCommand;
  fetchFn: typeof fetch;
  createActivityFn: typeof createAgentActivity;
  museRunner: typeof runMuse;
}): Promise<void> {
  const { agentSessionId, dataDir, jobStore, tokenManager, runner, fetchFn, createActivityFn, museRunner } = opts;

  const fresh = jobStore.load(agentSessionId);
  if (!fresh) return;
  const allFollowUps = fresh.followUps || [];
  const turnInput = allFollowUps.slice(fresh.consumedFollowUps || 0).join("\n");
  if (!turnInput.trim()) return;
  // Consume up front so messages arriving during this turn stay pending for
  // the next chained turn instead of being silently dropped.
  await jobStore.withSessionLock(agentSessionId, async () => {
    const rec = jobStore.load(agentSessionId);
    if (rec) {
      rec.consumedFollowUps = (rec.followUps || []).length;
      jobStore.save(rec);
    }
  });
  const updatedFollowUps = allFollowUps;


  // Try to determine repo/branch
  let repo: { id: string; path: string; github: string } | null = null;
  let branch: string | null = fresh.branch || null;
  // True when this turn deliberately chose scratch (smalltalk or unresolved):
  // a stored repo from an earlier turn must not resurrect a worktree.
  let decidedScratch = false;
  // Candidate context for a scratch resume when re-resolution finds zero or
  // multiple matches. The follow-up still reaches Muse once; Muse answers
  // or returns blocked asking for the target repo.
  let pendingResolution: { candidates: string[]; reason: string } | null = null;

  if (fresh.repo?.id && branch && !isQuickQuestion(turnInput)) {
    repo = { id: fresh.repo.id, path: fresh.repo.path, github: fresh.repo.github };
    const envKey = `GHOST_REPO_${repo.id.toUpperCase().replace(/-/g, "_")}_PATH`;
    const override = process.env[envKey];
    if (override && override.trim().startsWith("/")) repo.path = override.trim();
  } else {
    // Re-resolve from this turn's input alone, so a clarification like
    // "use scoutline" overrides an ambiguous original title such as
    // "scoutline and flaggo" — while consumed history can never escalate a
    // later smalltalk turn into a worktree. Fall back to combinedPrompt.
    const followOnly = turnInput;
    let rr = resolveRepository({
      issueIdentifier: undefined,
      issueTitle: undefined,
      promptContext: followOnly,
      rawPayload: null,
    });
    // If follow-up alone does not resolve to a single repo, try combined context (original + follow-ups) —
    // but only when the follow-up actually asks for code changes. Smalltalk must never escalate to a
    // worktree on the strength of background issue history.
    if ((!rr.repo || rr.candidates.length !== 1) && !isQuickQuestion(turnInput)) {
      // Check if followOnly was empty or ambiguous — try combined
      const combinedPrompt = [fresh.promptContext || "", ...updatedFollowUps].join("\n");
      const rrCombined = resolveRepository({
        issueIdentifier: fresh.issueIdentifier,
        issueTitle: fresh.issueTitle,
        promptContext: combinedPrompt,
        rawPayload: null,
      });
      // Prefer single-match from combined if followOnly didn't give one; if followOnly gave single but combined also single (unlikely), followOnly already wins.
      // If followOnly was ambiguous (multiple) but combined is also ambiguous, we keep that ambiguity — both are multiple, either is fine to report.
      // Only replace if followOnly didn't give single and combined does.
      if (rrCombined.repo) {
        // If followOnly had no match or multiple, combined's single is more useful
        rr = rrCombined;
      } else if (!rr.repo) {
        // Neither gave single, use combined for richer reason (includes original context)
        rr = rrCombined;
      }
      // If rr (followOnly) was multiple and combined is multiple, keep rr (followOnly) but either is okay; we now have rr as combined if it has single.
    }
    if (rr.repo) {
      repo = { id: rr.repo.id, path: rr.repo.path, github: rr.repo.github };
      branch = buildBranchName(fresh.issueIdentifier, agentSessionId);
      // Persist resolved repo/branch
      await jobStore.withSessionLock(agentSessionId, async () => {
        const rec = jobStore.load(agentSessionId);
        if (rec) {
          rec.repo = { id: repo!.id, path: repo!.path, github: repo!.github };
          rec.branch = branch!;
          rec.workspaceKind = "repo";
          rec.status = "running";
          jobStore.save(rec);
        }
      });
      await postActivity(tokenManager, agentSessionId, { type: "thought", body: `🔍 Resolved repository **${repo.id}** (\`${repo.github}\`) · branch \`${branch}\`` }, createActivityFn);
    } else {
      // Still zero or multiple matches — resume in the scratch workspace
      // with candidate context so the follow-up still reaches Muse once
      // instead of stopping before it. Muse answers directly when no change
      // is needed, or returns blocked asking for the target repository,
      // which is what sends the Linear elicitation.
      decidedScratch = true;
      pendingResolution = { candidates: rr.candidates.map((c) => c.id), reason: rr.reason };
      console.log(JSON.stringify({ msg: "repo re-resolution unresolved, resuming in scratch", reason: rr.reason, candidates: pendingResolution.candidates, sessionId: agentSessionId }));
      await jobStore.withSessionLock(agentSessionId, async () => {
        const rec = jobStore.load(agentSessionId);
        if (rec) {
          rec.status = "running";
          rec.workspaceKind = "scratch";
          jobStore.save(rec);
        }
      });
    }
  }

  // If we had repo but branch missing? ensure branch
  if (repo && !branch) {
    branch = buildBranchName(fresh.issueIdentifier, agentSessionId);
    await jobStore.withSessionLock(agentSessionId, async () => {
      const rec = jobStore.load(agentSessionId);
      if (rec) {
        rec.branch = branch!;
        rec.status = "running";
        jobStore.save(rec);
      }
    });
  } else if (repo && (fresh.status === "awaiting_input" || fresh.status === "completed") && fresh.repo) {
    // For already-resolved case, mark running
    await jobStore.withSessionLock(agentSessionId, async () => {
      const rec = jobStore.load(agentSessionId);
      if (rec && rec.status !== "running") {
        rec.status = "running";
        jobStore.save(rec);
      }
    });
  } else if (!repo) {
    // Scratch resume: ensure status running
    const cur = jobStore.load(agentSessionId);
    if (cur && cur.status !== "running") {
      await jobStore.withSessionLock(agentSessionId, async () => {
        const r = jobStore.load(agentSessionId);
        if (r) {
          r.status = "running";
          jobStore.save(r);
        }
      });
    }
  } else {
    // Already set to running above for newly resolved; ensure status running
    const cur = jobStore.load(agentSessionId);
    if (cur && cur.status !== "running") {
      await jobStore.withSessionLock(agentSessionId, async () => {
        const r = jobStore.load(agentSessionId);
        if (r) {
          r.status = "running";
          jobStore.save(r);
        }
      });
    }
  }

  await postActivity(tokenManager, agentSessionId, { type: "thought", body: `📝 Received follow-up (${turnInput.length} chars), resuming work…` }, createActivityFn);

  // Re-load to ensure repo/branch/workspace persisted. A stored repo is only
  // reused when this turn did not deliberately choose scratch.
  const loadedForPipeline = jobStore.load(agentSessionId);
  const storedRepo = !decidedScratch && loadedForPipeline?.repo
    ? { id: loadedForPipeline.repo.id, path: loadedForPipeline.repo.path, github: loadedForPipeline.repo.github }
    : null;
  const finalRepo = repo || storedRepo;
  const finalBranch = branch || loadedForPipeline?.branch || "";

  const ctx: GhostJobContext = {
    agentSessionId,
    issueIdentifier: fresh.issueIdentifier,
    issueTitle: fresh.issueTitle,
    promptContext: fresh.promptContext,
    rawPayload: null,
  };

  // Scratch resume: no repo resolved — re-run Muse in the same scratch
  // workspace (or a fresh one). Never enters git/PR operations.
  if (!finalRepo || !finalBranch) {
    try {
      await runScratchPipeline({
        ctx,
        dataDir,
        jobStore,
        tokenManager,
        createActivityFn,
        museRunner,
        scratchPath: loadedForPipeline?.scratchPath,
        repoResolution: pendingResolution || undefined,
        directive: turnInput.slice(0, 2000),
      });
    } catch (err) {
      const safe = sanitizeError((err as Error).message, 600);
      console.error(JSON.stringify({ msg: "resume scratch pipeline error", sessionId: agentSessionId, error: safe }));
      await jobStore.withSessionLock(agentSessionId, async () => {
        const rec = jobStore.load(agentSessionId);
        if (rec && rec.status !== "completed" && rec.status !== "awaiting_input") {
          rec.status = "failed";
          rec.error = safe.slice(0, 800);
          jobStore.save(rec);
        }
      });
      await postActivity(tokenManager, agentSessionId, { type: "error", body: `Ghost encountered an error while resuming: ${safe}` }, createActivityFn);
    }
    return;
  }

  const worktreesDir = getWorktreesDir(dataDir);

  try {
    // No pipeline-wide lock here either; see handleAgentSessionCreated.
    await runRepoPipeline({
      ctx,
      repo: finalRepo,
      branch: finalBranch,
      dataDir,
      worktreesDir,
      jobStore,
      tokenManager,
      runner,
      fetchFn,
      createActivityFn,
      museRunner,
      directive: turnInput.slice(0, 2000),
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
      if (rec?.worktreePath && rec.status === "failed") {
        await cleanupWorktreeAndBranch({ dataDir, worktreePath: rec.worktreePath, targetRepoPath: finalRepo.path, branch: finalBranch, runner, jobStore, repoId: finalRepo.id });
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
/**
 * Run turns until no unanswered messages remain (or the cap hits). A new
 * message in the same chat starts a new turn — including after a previous
 * turn completed, and including messages that arrived mid-turn. The in-flight
 * turn is never interrupted; queued messages chain behind it.
 */
export async function drainPendingTurns(opts: {
  agentSessionId: string;
  dataDir: string;
  jobStore: JobStore;
  tokenManager: LinearTokenManager;
  runner: typeof runCommand;
  fetchFn: typeof fetch;
  createActivityFn: typeof createAgentActivity;
  museRunner: typeof runMuse;
}): Promise<void> {
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
