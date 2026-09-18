import type { createAgentActivity, LinearTokenManager } from "./linear.js";
import type { JobStore } from "./jobStore.js";
import type { GhostJobContext } from "./sessionTypes.js";
import { buildMusePrompt, runMuse, ProgressTracker, createProgressPoster, MUSE_QUICK_REASONING_EFFORT, MUSE_QUICK_MAX_MODEL_STEPS, type MuseResult } from "./museRunner.js";
import { ensureWorktree, validateWorktree, commitAndPush, getChangedFiles, cleanupWorktreeIfAllowed, pruneLocalBranchIfSafe } from "./gitPipeline.js";
import { createPullRequest, getGithubToken } from "./github.js";
import { getCompareUrl, resolveRepository, buildBranchName } from "./repoResolver.js";
import { runCommand, sanitizeError } from "./commandRunner.js";
import { postActivity, persistMuseResult, handleBlocked, sanitizeModelString, sanitizeModelResult } from "./activities.js";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";

async function tryCleanupWorktree(opts: { dataDir: string; worktreePath?: string; targetRepoPath: string; runner?: typeof runCommand }): Promise<void> {
  if (!opts.worktreePath) return;
  try {
    await cleanupWorktreeIfAllowed({ targetRepoPath: opts.targetRepoPath, worktreePath: opts.worktreePath, dataDir: opts.dataDir, runner: opts.runner });
  } catch {}
}

export function getDataDir(): string {
  return (process.env.GHOST_DATA_DIR || "/home/rohan/.config/ghost").trim();
}

export function getWorktreesDir(dataDir: string): string {
  return join(dataDir, "worktrees");
}

function getScratchDir(dataDir: string): string {
  return join(dataDir, "scratch");
}

/**
 * Private per-session workspace for plain Q&A (no resolved repository). One
 * directory per session so concurrent sessions can never step on each other.
 * It must never enter git/PR operations.
 */
export function ensureScratchWorkspace(dataDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "unknown";
  const scratchPath = join(getScratchDir(dataDir), safe);
  mkdirSync(scratchPath, { recursive: true, mode: 0o700 });
  try {
    chmodSync(scratchPath, 0o700);
  } catch {}
  return scratchPath;
}
export async function cleanupWorktreeAndBranch(opts: {
  dataDir: string;
  worktreePath?: string;
  targetRepoPath: string;
  branch?: string;
  runner?: typeof runCommand;
  /** When provided, the shared-checkout git ops run under the per-repo lock. */
  jobStore?: JobStore;
  repoId?: string;
}): Promise<void> {
  const run = async (): Promise<void> => {
    await tryCleanupWorktree(opts);
    if (!opts.branch) return;
    try {
      await pruneLocalBranchIfSafe({ targetRepoPath: opts.targetRepoPath, branch: opts.branch, runner: opts.runner });
    } catch {}
  };
  if (opts.jobStore && opts.repoId) {
    await opts.jobStore.withRepoLock(opts.repoId, run);
  } else {
    await run();
  }
}
/** Invoke Muse once and return the sanitized result. */
export async function invokeMuseOnce(opts: {
  ctx: GhostJobContext;
  workspacePath: string;
  workspaceKind: "repo" | "scratch";
  repoId?: string;
  branch?: string;
  /** Candidate repo ids + resolution note for scratch prompts (zero/multi matches). */
  repoResolution?: { candidates: string[]; reason: string };
  directive?: string;
  /** One-place worktree convention for repo workspaces; omitted for scratch. */
  worktreeHint?: string;
  jobStore: JobStore;
  tokenManager: LinearTokenManager;
  createActivityFn: typeof createAgentActivity;
  museRunner: typeof runMuse;
}): Promise<MuseResult> {
  const { ctx, workspacePath, workspaceKind, repoId, branch, repoResolution, directive, worktreeHint, jobStore, tokenManager, createActivityFn, museRunner } = opts;
  const jobForPrompt = jobStore.load(ctx.agentSessionId);
  const storedFollowUps = jobForPrompt?.followUps || [];
  // This turn answers only messages it hasn't consumed yet. Anything arriving
  // mid-turn stays pending for the next chained turn in the same session.
  const followUps = storedFollowUps.slice(jobForPrompt?.consumedFollowUps || 0);
  if (jobForPrompt && storedFollowUps.length > (jobForPrompt.consumedFollowUps || 0)) {
    await jobStore.withSessionLock(ctx.agentSessionId, async () => {
      const rec = jobStore.load(ctx.agentSessionId);
      if (rec) {
        rec.consumedFollowUps = (rec.followUps || []).length;
        jobStore.save(rec);
      }
    });
  }

  const prompt = buildMusePrompt({
    issueIdentifier: ctx.issueIdentifier,
    issueTitle: ctx.issueTitle,
    promptContext: ctx.promptContext,
    followUps,
    repoId,
    branch,
    workspaceKind,
    workspacePath,
    candidates: repoResolution?.candidates,
    resolutionReason: repoResolution?.reason,
    directive,
    worktreeHint,
  });

  // Live progress: forward tool start/finish markers as thought activities so
  // the session shows movement during long model runs. Throttled and capped;
  // only tool names flow through, never model output.
  const progress = new ProgressTracker();

  // Compute budget follows the workspace: scratch Q&A gets low deliberation
  // and fewer steps (fast answers); repo work keeps full reasoning depth.
  const quick = workspaceKind === "scratch";
  let muse: MuseResult;
  try {
    muse = await museRunner({
      workspace: workspacePath,
      prompt,
      reasoningEffort: quick ? MUSE_QUICK_REASONING_EFFORT : undefined,
      maxModelSteps: quick ? Number(MUSE_QUICK_MAX_MODEL_STEPS) : undefined,
      onProgressLine: createProgressPoster(progress, (body: string) => {
        void postActivity(tokenManager, ctx.agentSessionId, { type: "thought", body: sanitizeError(body, 200) }, createActivityFn).then((ok) => {
          console.log(JSON.stringify({ msg: "progress thought posted", sessionId: ctx.agentSessionId, ok }));
        });
      }),
    });
  } catch (err) {
    const msg = sanitizeError((err as Error).message, 600);
    throw new Error(`Muse execution failed: ${msg}`);
  }

  console.log(
    JSON.stringify({ msg: "Muse result", status: muse.status, sessionId: ctx.agentSessionId }),
  );

  // Redact every model-controlled field before any persistence or external use
  muse = sanitizeModelResult(muse);
  await persistMuseResult(jobStore, ctx.agentSessionId, muse);
  return muse;
}

/**
 * Ticket stage: the chat gate already decided this message needs the ticket.
 * Run one model call with the full ticket in scratch. The model answers
 * read-only questions directly, returns blocked when the user must supply
 * information, or sets wants_work when repository code changes are needed —
 * only then is a repo resolved and the work pipeline started.
 */
export async function runTicketPipeline(opts: {
  ctx: GhostJobContext;
  dataDir: string;
  jobStore: JobStore;
  tokenManager: LinearTokenManager;
  runner: typeof runCommand;
  fetchFn: typeof fetch;
  createActivityFn: typeof createAgentActivity;
  museRunner: typeof runMuse;
  scratchPath?: string;
  message?: string;
  /** Repo resolved on an earlier turn of this session. Reused only when this turn's text names no repo. */
  knownRepo?: { id: string; path: string; github: string };
}): Promise<void> {
  const { ctx, dataDir, jobStore, tokenManager, runner, fetchFn, createActivityFn, museRunner, message, knownRepo } = opts;

  // Private per-session workspace. Never enters git/PR operations.
  const scratchPath = opts.scratchPath || ensureScratchWorkspace(dataDir, ctx.agentSessionId);

  await jobStore.withSessionLock(ctx.agentSessionId, async () => {
    const rec = jobStore.load(ctx.agentSessionId);
    if (rec) {
      rec.scratchPath = scratchPath;
      rec.workspaceKind = "scratch";
      jobStore.save(rec);
    }
  });

  console.log(JSON.stringify({ msg: "ticket workspace ready", scratchPath, sessionId: ctx.agentSessionId }));

  const muse = await invokeMuseOnce({
    ctx,
    workspacePath: scratchPath,
    workspaceKind: "scratch",
    jobStore,
    tokenManager,
    createActivityFn,
    museRunner,
    directive: message,
  });

  if (muse.status === "blocked") {
    await handleBlocked(jobStore, tokenManager, ctx.agentSessionId, muse, createActivityFn);
    return;
  }

  if (muse.wants_work === true) {
    // This turn's message first, so a clarification like "use flaggo"
    // overrides an ambiguous original title; otherwise the combined context.
    const followOnly = message
      ? resolveRepository({ promptContext: message })
      : null;
    const repoResult = followOnly && followOnly.repo
      ? followOnly
      : resolveRepository({
        issueIdentifier: ctx.issueIdentifier,
        issueTitle: ctx.issueTitle,
        promptContext: [ctx.promptContext, message].filter(Boolean).join("\n"),
        rawPayload: ctx.rawPayload,
      });
    // Follow-up turns ("do it", "continue") often name no repo: reuse the
    // session's known repo. An explicit single match always wins (redirects
    // like "use flaggo" work); ambiguity still asks the user.
    const repo = repoResult.repo || (repoResult.candidates.length === 0 ? knownRepo || null : null);
    if (!repo) {
      await jobStore.withSessionLock(ctx.agentSessionId, async () => {
        const rec = jobStore.load(ctx.agentSessionId);
        if (rec) {
          rec.status = "awaiting_input";
          jobStore.save(rec);
        }
      });
      const question =
        repoResult.elicitation ||
        "Which repository should I work in? Reply with one repo name.";
      await postActivity(tokenManager, ctx.agentSessionId, { type: "elicitation", body: question }, createActivityFn);
      console.log(JSON.stringify({ msg: "wants work but repo unresolved, eliciting", reason: repoResult.reason, sessionId: ctx.agentSessionId }));
      return;
    }
    const branch = buildBranchName(ctx.issueIdentifier, ctx.agentSessionId);
    console.log(JSON.stringify({ msg: "repo resolved", repo: repo.id, branch, sessionId: ctx.agentSessionId }));
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
    await runRepoPipeline({
      ctx,
      repo,
      branch,
      dataDir,
      worktreesDir: getWorktreesDir(dataDir),
      jobStore,
      tokenManager,
      runner,
      fetchFn,
      createActivityFn,
      museRunner,
      directive: message,
    });
    return;
  }

  // Answered from the ticket: post bare and complete. No worktree, no commit.
  await jobStore.withSessionLock(ctx.agentSessionId, async () => {
    const rec = jobStore.load(ctx.agentSessionId);
    if (rec) {
      rec.status = "completed";
      jobStore.save(rec);
    }
  });

  const safeSummary = sanitizeModelString(muse.summary, 4000);
  const safeRisks = muse.residual_risks.length > 0
    ? `\n\nResidual risks: ${sanitizeModelString(muse.residual_risks.join("; "), 500)}`
    : "";
  const finalBody = `${safeSummary}${safeRisks}`;
  await postActivity(tokenManager, ctx.agentSessionId, { type: "response", body: sanitizeModelString(finalBody, 6000) }, createActivityFn);

  console.log(JSON.stringify({ msg: "Ghost ticket pipeline completed", sessionId: ctx.agentSessionId }));
}

export async function runRepoPipeline(opts: {
  ctx: GhostJobContext;
  repo: { id: string; path: string; github: string };
  branch: string;
  dataDir: string;
  worktreesDir: string;
  jobStore: JobStore;
  tokenManager: LinearTokenManager;
  runner: typeof runCommand;
  fetchFn: typeof fetch;
  createActivityFn: typeof createAgentActivity;
  museRunner: typeof runMuse;
  directive?: string;
}): Promise<void> {
  const { ctx, repo, branch, worktreesDir, jobStore, tokenManager, runner, fetchFn, createActivityFn, museRunner, directive } = opts;

  // Ensure worktree
  await postActivity(tokenManager, ctx.agentSessionId, { type: "thought", body: `🌿 Setting up isolated worktree for \`${branch}\` from \`origin/main\`` }, createActivityFn);

  let worktreePath: string;
  try {
    // Only the shared-checkout git setup holds the per-repo lock; the long
    // Muse run, validation, and worktree-local commit below run concurrently.
    worktreePath = await jobStore.withRepoLock(repo.id, () =>
      ensureWorktree({
        targetRepoPath: repo.path,
        worktreeBaseDir: worktreesDir,
        branch,
        sessionId: ctx.agentSessionId,
        dataDir: opts.dataDir,
        runner,
      }),
    );
  } catch (err) {
    const msg = sanitizeError((err as Error).message, 600);
    throw new Error(`Worktree setup failed: ${msg}`);
  }

  // Persist worktreePath
  await jobStore.withSessionLock(ctx.agentSessionId, async () => {
    const rec = jobStore.load(ctx.agentSessionId);
    if (rec) {
      rec.worktreePath = worktreePath;
      rec.workspaceKind = "repo";
      jobStore.save(rec);
    }
  });

  console.log(JSON.stringify({ msg: "worktree ready", worktreePath, sessionId: ctx.agentSessionId }));

  await postActivity(tokenManager, ctx.agentSessionId, { type: "thought", body: `✅ Worktree ready at \`${worktreePath}\` · branch \`${branch}\`` }, createActivityFn);

  // One-place worktree convention so the model knows how/where to create an
  // additional worktree itself when the user asks for one. Ghost does not
  // create worktrees beyond this session's.
  const worktreeHint =
    `Worktree convention (only when the user explicitly asks for another worktree): create it under ${opts.dataDir}/worktrees/<session-id> ` +
    `on a branch named like this one (ghost/<issue>-<session>) from a freshly fetched origin/main; ` +
    `never modify, clean, stash, or reset the main checkout at ${repo.path}.`;

  const muse = await invokeMuseOnce({
    ctx,
    workspacePath: worktreePath,
    workspaceKind: "repo",
    repoId: repo.id,
    branch,
    jobStore,
    tokenManager,
    createActivityFn,
    museRunner,
    directive,
    worktreeHint,
  });

  if (muse.status === "blocked") {
    // Persist awaiting_input, send elicitation, do not commit/push
    await handleBlocked(jobStore, tokenManager, ctx.agentSessionId, muse, createActivityFn);
    return;
  }

  // Inspect the actual workspace: only publish when files really changed.
  // If Muse answered without editing files, post the summary directly and
  // complete — no commit, push, PR, or validation required.
  let actualChangedFiles: string[];
  try {
    actualChangedFiles = await getChangedFiles(worktreePath, runner);
  } catch (err) {
    const msg = sanitizeError((err as Error).message, 600);
    throw new Error(`Failed to inspect worktree changes: ${msg}`);
  }

  if (actualChangedFiles.length === 0) {
    console.log(JSON.stringify({ msg: "no worktree changes, answering directly", sessionId: ctx.agentSessionId }));
    await jobStore.withSessionLock(ctx.agentSessionId, async () => {
      const rec = jobStore.load(ctx.agentSessionId);
      if (rec) {
        rec.status = "completed";
        rec.changedFiles = [];
        jobStore.save(rec);
      }
    });
    const safeSummary = sanitizeModelString(muse.summary, 4000);
    const safeRisks = muse.residual_risks.length > 0
      ? `\n\nResidual risks: ${sanitizeModelString(muse.residual_risks.join("; "), 500)}`
      : "";
    const finalBody =
      `✅ Ghost finished **${ctx.issueIdentifier || "the task"}**${ctx.issueTitle ? ` — "${ctx.issueTitle}"` : ""}\n\n` +
      `${safeSummary}\n\n_No file changes were needed, so nothing was committed or pushed._${safeRisks}`;
    await postActivity(tokenManager, ctx.agentSessionId, { type: "response", body: sanitizeModelString(finalBody, 6000) }, createActivityFn);
    console.log(JSON.stringify({ msg: "Ghost pipeline completed (no changes)", sessionId: ctx.agentSessionId, branch }));
    await cleanupWorktreeAndBranch({ dataDir: opts.dataDir, worktreePath, targetRepoPath: repo.path, branch, runner, jobStore, repoId: repo.id });
    return;
  }

  console.log(JSON.stringify({ msg: "worktree changes detected", files: actualChangedFiles.length, sessionId: ctx.agentSessionId }));

  // Ghost independent validation
  await postActivity(tokenManager, ctx.agentSessionId, { type: "thought", body: `🔬 Muse finished with changes. Ghost validating worktree…` }, createActivityFn);

  let validationPerformed: string[] = [];
  let checks: Array<{ name: string; ok: boolean; output?: string }> = [];
  try {
    const validation = await validateWorktree({ worktreePath, runner });
    validationPerformed = validation.performed;
    checks = validation.results;
    // Persist checks
    await jobStore.withSessionLock(ctx.agentSessionId, async () => {
      const rec = jobStore.load(ctx.agentSessionId);
      if (rec) {
        rec.validationPerformed = validationPerformed;
        rec.checks = checks;
        rec.changedFiles = actualChangedFiles.map((f) => sanitizeModelString(f, 500)).slice(0, 100);
        jobStore.save(rec);
      }
    });
  } catch (err) {
    const msg = sanitizeError((err as Error).message, 600);
    await jobStore.withSessionLock(ctx.agentSessionId, async () => {
      const rec = jobStore.load(ctx.agentSessionId);
      if (rec) {
        rec.status = "failed";
        rec.error = `Validation failed: ${msg}`.slice(0, 800);
        rec.validationPerformed = validationPerformed;
        rec.checks = checks;
        jobStore.save(rec);
      }
    });
    await postActivity(tokenManager, ctx.agentSessionId, { type: "error", body: `❌ Validation failed: ${msg}` }, createActivityFn);
    await cleanupWorktreeAndBranch({ dataDir: opts.dataDir, worktreePath, targetRepoPath: repo.path, branch, runner, jobStore, repoId: repo.id });
    throw new Error(`Validation failed: ${msg}`);
  }

  // Commit & push
  await postActivity(tokenManager, ctx.agentSessionId, { type: "thought", body: `📤 Committing and pushing branch \`${branch}\`…` }, createActivityFn);

  let commitSha: string;
  try {
    commitSha = await commitAndPush({
      worktreePath,
      targetRepoPath: repo.path,
      branch,
      issueIdentifier: ctx.issueIdentifier,
      issueTitle: ctx.issueTitle,
      runner,
    });
  } catch (err) {
    const msg = sanitizeError((err as Error).message, 600);
    await jobStore.withSessionLock(ctx.agentSessionId, async () => {
      const rec = jobStore.load(ctx.agentSessionId);
      if (rec) {
        rec.status = "failed";
        rec.error = `Commit/push failed: ${msg}`.slice(0, 800);
        jobStore.save(rec);
      }
    });
    await postActivity(tokenManager, ctx.agentSessionId, { type: "error", body: `❌ Commit/push failed: ${msg}` }, createActivityFn);
    await cleanupWorktreeAndBranch({ dataDir: opts.dataDir, worktreePath, targetRepoPath: repo.path, branch, runner, jobStore, repoId: repo.id });
    throw new Error(`Commit/push failed: ${msg}`);
  }

  await jobStore.withSessionLock(ctx.agentSessionId, async () => {
    const rec = jobStore.load(ctx.agentSessionId);
    if (rec) {
      rec.commitSha = commitSha;
      jobStore.save(rec);
    }
  });

  // PR or compare URL
  const githubToken = getGithubToken();
  let prUrl: string | undefined;
  let compareUrl: string | undefined;

  if (githubToken) {
    await postActivity(tokenManager, ctx.agentSessionId, { type: "thought", body: `🔗 Creating pull request for \`${branch}\`…` }, createActivityFn);
    try {
      // Redact model-controlled summary before external GitHub payload
      const safePrSummary = sanitizeModelString(muse.summary, 3000);
      const safePrBody = `${safePrSummary}\n\nBranch: \`${branch}\`\nChecks: ${validationPerformed.join(", ") || "none"}\nCommit: \`${commitSha.slice(0, 7)}\``;
      const redactedTitle = sanitizeModelString(`${ctx.issueIdentifier || "Ghost"} ${ctx.issueTitle || ""}`.trim().slice(0, 120) || `Ghost ${branch}`, 120);
      const prRes = await createPullRequest(
        {
          token: githubToken,
          ownerRepo: repo.github,
          branch,
          title: redactedTitle,
          body: sanitizeModelString(safePrBody, 8000),
          base: "main",
        },
        fetchFn,
      );
      prUrl = prRes.prUrl;
      compareUrl = prRes.compareUrl;
    } catch (err) {
      console.error(JSON.stringify({ msg: "PR creation error", error: sanitizeError((err as Error).message, 300) }));
      compareUrl = getCompareUrl(repo.github, branch);
    }
  } else {
    compareUrl = getCompareUrl(repo.github, branch);
    console.log(JSON.stringify({ msg: "no github token, using compare URL", compareUrl }));
  }

  // Persist PR/compare URLs and mark completed
  await jobStore.withSessionLock(ctx.agentSessionId, async () => {
    const rec = jobStore.load(ctx.agentSessionId);
    if (rec) {
      rec.status = "completed";
      rec.prUrl = prUrl;
      rec.compareUrl = compareUrl;
      rec.commitSha = commitSha;
      jobStore.save(rec);
    }
  });

  // Final response must include summary, branch, checks, and PR or compare URL — use only redacted copies
  const checksStr = validationPerformed.length > 0 ? validationPerformed.join(", ") : "none (no recognized scripts)";
  const prLine = prUrl ? `PR: ${prUrl}` : `Compare: ${compareUrl}`;
  const safeSummaryForResponse = sanitizeModelString(muse.summary, 2000);
  const safeRisksForResponse = muse.residual_risks.length > 0
    ? `Residual risks: ${sanitizeModelString(muse.residual_risks.join("; "), 500)}\n`
    : "";
  const finalBody =
    `✅ Ghost finished **${ctx.issueIdentifier || "the task"}**${ctx.issueTitle ? ` — "${ctx.issueTitle}"` : ""}\n\n` +
    `${safeSummaryForResponse}\n\n` +
    `Branch: \`${branch}\`\n` +
    `Commit: \`${commitSha.slice(0, 7)}\`\n` +
    `Checks: ${checksStr}\n` +
    `${prLine}\n\n` +
    safeRisksForResponse;

  await postActivity(tokenManager, ctx.agentSessionId, { type: "response", body: sanitizeModelString(finalBody, 6000) }, createActivityFn);

  console.log(JSON.stringify({ msg: "Ghost pipeline completed", sessionId: ctx.agentSessionId, branch, prUrl, compareUrl }));

  // Best-effort cleanup of isolated worktree on terminal completed (not awaiting_input)
  await cleanupWorktreeAndBranch({ dataDir: opts.dataDir, worktreePath, targetRepoPath: repo.path, branch, runner, jobStore, repoId: repo.id });
}
