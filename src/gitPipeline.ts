import { existsSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCommand, sanitizeError } from "./commandRunner.js";
import { selectValidationChecks } from "./validation.js";
import { isSecretPath } from "./validation.js";
import { buildSafeEnv } from "./childEnv.js";

export interface GitPipelineDeps {
  runner?: typeof runCommand;
  dataDir: string;
}

export function sanitizeCommitMessage(issueIdentifier?: string, issueTitle?: string): string {
  const parts: string[] = [];
  if (issueIdentifier) {
    // Keep only safe chars for branch/issue
    const safeId = issueIdentifier.replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 80);
    parts.push(safeId);
  }
  if (issueTitle) {
    const safeTitle = issueTitle.replace(/[\r\n]+/g, " ").slice(0, 100).replace(/"/g, "'");
    parts.push(safeTitle);
  }
  const base = parts.join(" — ").slice(0, 150) || "Ghost automated update";
  // Ensure no secret leakage: already limited
  return base;
}

export async function ensureWorktree(opts: {
  targetRepoPath: string;
  worktreeBaseDir: string;
  branch: string;
  sessionId: string;
  dataDir: string;
  runner?: typeof runCommand;
}): Promise<string> {
  // Wrap runner to enforce least-privilege safe env for git ops (no service secrets).
  // If caller supplied a mocked runner (tests), we wrap it to inject safe env
  // capture for verification while preserving mock behavior.
  const rawRunner = opts.runner || runCommand;
  const runner: typeof runCommand = (rOpts) => {
    // When using real runCommand, env omission defaults to safe env via commandRunner.
    // For mocked runners in tests, inject safe env explicitly so tests can assert isolation.
    if (!rOpts.env) {
      return rawRunner({ ...rOpts, env: buildSafeEnv() } as any);
    }
    return rawRunner(rOpts as any);
  };
  const worktreePath = join(opts.worktreeBaseDir, opts.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64));

  // Ensure base dir exists with 0700
  mkdirSync(opts.worktreeBaseDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(opts.worktreeBaseDir, 0o700);
  } catch {}

  // Step 1: fetch origin/main in target repo (does not modify dirty worktree, only refs)
  console.log(JSON.stringify({ msg: "git fetch origin/main", target: opts.targetRepoPath }));
  const fetchRes = await runner({
    command: "git",
    args: ["fetch", "origin", "main"],
    cwd: opts.targetRepoPath,
    timeoutMs: 60_000,
    maxOutputBytes: 200_000,
  });
  if (fetchRes.timedOut) {
    throw new Error(`git fetch timed out after 60s`);
  }
  if (fetchRes.exitCode !== 0) {
    throw new Error(`git fetch failed (exit ${fetchRes.exitCode})`);
  }

  // Step 2: check if remote branch already exists — treat timeout/exit failure as failure, not "no branch"
  const lsRemote = await runner({
    command: "git",
    args: ["ls-remote", "--heads", "origin", opts.branch],
    cwd: opts.targetRepoPath,
    timeoutMs: 15_000,
  });
  if (lsRemote.timedOut) {
    throw new Error(`git ls-remote timed out checking remote branch ${opts.branch}`);
  }
  if (lsRemote.exitCode !== 0) {
    throw new Error(`git ls-remote failed (exit ${lsRemote.exitCode})`);
  }
  const remoteExists = lsRemote.stdout.trim().length > 0;

  // Step 3: if worktree directory already exists, verify it is a valid worktree of expected repo+branch; else fail
  if (existsSync(worktreePath)) {
    // Verify it is a git worktree checked out on expected branch and belonging to expected targetRepoPath
    let verified = false;
    try {
      // Check that worktreePath is a git repo/worktree
      const revParse = await runner({
        command: "git",
        args: ["rev-parse", "--is-inside-work-tree"],
        cwd: worktreePath,
        timeoutMs: 10_000,
      });
      if (revParse.exitCode === 0 && revParse.stdout.trim() === "true") {
        // Check branch
        const branchRes = await runner({
          command: "git",
          args: ["rev-parse", "--abbrev-ref", "HEAD"],
          cwd: worktreePath,
          timeoutMs: 10_000,
        });
        const currentBranch = branchRes.stdout.trim();
        // Check that worktree's origin matches expected target (via git rev-parse --git-common-dir or remote URL)
        const remoteUrlRes = await runner({
          command: "git",
          args: ["config", "--get", "remote.origin.url"],
          cwd: worktreePath,
          timeoutMs: 10_000,
        });
        const targetRemoteRes = await runner({
          command: "git",
          args: ["config", "--get", "remote.origin.url"],
          cwd: opts.targetRepoPath,
          timeoutMs: 10_000,
        });
        const worktreeRemote = remoteUrlRes.stdout.trim();
        const targetRemote = targetRemoteRes.stdout.trim();
        // If both remotes available and mismatch, fail
        const remoteMismatch = worktreeRemote && targetRemote && worktreeRemote !== targetRemote;
        if (currentBranch === opts.branch && !remoteMismatch && !branchRes.timedOut && !remoteUrlRes.timedOut) {
          verified = true;
        } else {
          // Provide specific failure reason
          if (currentBranch !== opts.branch) {
            throw new Error(`Existing worktree at ${worktreePath} is on branch ${currentBranch}, expected ${opts.branch}; refusing to reuse`);
          }
          if (remoteMismatch) {
            throw new Error(`Existing worktree remote mismatch: worktree remote ${worktreeRemote} != target ${targetRemote}; refusing to reuse`);
          }
        }
      }
    } catch (e: any) {
      // If we threw explicit mismatch above, rethrow
      if (e && typeof e.message === "string" && e.message.includes("refusing to reuse")) throw e;
      // Otherwise, verification failed generically
      throw new Error(`Existing directory ${worktreePath} failed worktree verification: ${e?.message?.slice(0, 300) || "unknown"}; refusing to reuse`);
    }
    if (verified) {
      // Also enforce remote branch policy: if remote exists, we only allow reuse if this verification passed (same job). Already verified above.
      // If remoteExists and we verified, it's ok — it's same job retry.
      console.log(JSON.stringify({ msg: "worktree already exists, verified reusing", worktreePath }));
      return worktreePath;
    }
    throw new Error(`Existing directory ${worktreePath} is not a verified worktree for ${opts.branch}; refusing to reuse`);
  }

  // Step 4: remote-branch reuse must not rely solely on directory existence. Require verifiable same-job state or refuse.
  if (remoteExists) {
    // Since worktreePath does NOT exist (checked above), this is a different job trying to reuse an existing remote branch — conservatively refuse
    throw new Error(`Remote branch ${opts.branch} already exists on origin; refusing to overwrite (different job). No local worktree for this session.`);
  }

  console.log(JSON.stringify({ msg: "git worktree add", worktreePath, branch: opts.branch }));
  // Use git worktree add -b <branch> <path> origin/main — no force
  const res = await runner({
    command: "git",
    args: ["worktree", "add", "-b", opts.branch, worktreePath, "origin/main"],
    cwd: opts.targetRepoPath,
    timeoutMs: 30_000,
  });
  if (res.exitCode !== 0) {
    // Maybe branch exists locally already
    const checkBranch = await runner({
      command: "git",
      args: ["branch", "--list", opts.branch],
      cwd: opts.targetRepoPath,
      timeoutMs: 10_000,
    });
    if (checkBranch.stdout.includes(opts.branch)) {
      throw new Error(`Branch ${opts.branch} already exists locally; refusing to reuse`);
    }
    throw new Error(`git worktree add failed (exit ${res.exitCode}): ${res.stderr.slice(0, 400)}`);
  }

  return worktreePath;
}

export async function validateWorktree(opts: {
  worktreePath: string;
  runner?: typeof runCommand;
}): Promise<{ performed: string[]; available: string[]; results: Array<{ name: string; ok: boolean; output?: string }> }> {
  const rawRunner = opts.runner || runCommand;
  const runner: typeof runCommand = (rOpts) => {
    if (!rOpts.env) return rawRunner({ ...rOpts, env: buildSafeEnv() } as any);
    return rawRunner(rOpts as any);
  };
  const pkgPath = join(opts.worktreePath, "package.json");
  let pkg: any = {};
  let available: string[] = [];
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      available = pkg.scripts ? Object.keys(pkg.scripts).filter((k: string) => ["test", "typecheck", "lint", "build"].includes(k)) : [];
    } catch {}
  }

  const selected = selectValidationChecks(pkg);
  const performed: string[] = [];
  const results: Array<{ name: string; ok: boolean; output?: string }> = [];

  for (const check of selected) {
    performed.push(check.name);
    console.log(JSON.stringify({ msg: "validation start", check: check.name, worktree: opts.worktreePath }));
    const res = await runner({
      command: check.command,
      args: check.args,
      cwd: opts.worktreePath,
      timeoutMs: 120_000,
      maxOutputBytes: 500_000,
    });
    if (res.timedOut) {
      results.push({ name: check.name, ok: false });
      throw new Error(`Validation ${check.name} timed out`);
    }
    if (res.exitCode !== 0) {
      // Do not include stdout/stderr in persisted checks or Linear activities — keep to safe metadata only
      results.push({ name: check.name, ok: false });
      throw new Error(`Validation ${check.name} failed (exit ${res.exitCode})`);
    }
    results.push({ name: check.name, ok: true });
    console.log(JSON.stringify({ msg: "validation passed", check: check.name }));
  }

  if (selected.length === 0) {
    console.log(JSON.stringify({ msg: "no validation scripts found", available }));
  }

  return { performed, available, results };
}

function wrapRunner(raw: typeof runCommand): typeof runCommand {
  return (rOpts) => {
    if (!rOpts.env) return raw({ ...rOpts, env: buildSafeEnv() } as any);
    return raw(rOpts as any);
  };
}

export async function getChangedFiles(worktreePath: string, runner?: typeof runCommand): Promise<string[]> {
  const r = wrapRunner(runner || runCommand);
  // Use git status --porcelain to list changed files
  const res = await r({
    command: "git",
    args: ["status", "--porcelain"],
    cwd: worktreePath,
    timeoutMs: 10_000,
  });
  if (res.exitCode !== 0) throw new Error(`git status failed: exit ${res.exitCode}`);
  const lines = res.stdout.split("\n").filter((l) => l.trim());
  const files = lines.map((l) => l.slice(3).trim()).filter(Boolean);
  // Also handle renames: "R  old -> new"
  const normalized: string[] = [];
  for (const f of files) {
    if (f.includes(" -> ")) {
      const parts = f.split(" -> ");
      normalized.push(parts[1].trim());
    } else {
      normalized.push(f);
    }
  }
  return normalized;
}

export async function ensureNonEmptyDiff(worktreePath: string, runner?: typeof runCommand): Promise<void> {
  const files = await getChangedFiles(worktreePath, runner);
  if (files.length === 0) {
    throw new Error("No changes detected (empty git diff) — refusing to commit");
  }
  // Check for secret files
  for (const f of files) {
    const sec = isSecretPath(f);
    if (sec.blocked) {
      throw new Error(`Blocked secret file in diff: ${f} (${sec.reason}) — commit rejected`);
    }
  }
}

export async function commitAndPush(opts: {
  worktreePath: string;
  targetRepoPath: string;
  branch: string;
  issueIdentifier?: string;
  issueTitle?: string;
  runner?: typeof runCommand;
}): Promise<string> {
  const runner = wrapRunner(opts.runner || runCommand);

  await ensureNonEmptyDiff(opts.worktreePath, runner);

  // git add -A
  const addRes = await runner({
    command: "git",
    args: ["add", "-A"],
    cwd: opts.worktreePath,
    timeoutMs: 15_000,
  });
  if (addRes.exitCode !== 0) throw new Error(`git add failed: exit ${addRes.exitCode}`);

  // Verify again no secret after add? Already checked.

  const msg = sanitizeCommitMessage(opts.issueIdentifier, opts.issueTitle);
  const commitRes = await runner({
    command: "git",
    args: ["commit", "-m", msg],
    cwd: opts.worktreePath,
    timeoutMs: 15_000,
  });
  if (commitRes.exitCode !== 0) {
    throw new Error(`git commit failed (exit ${commitRes.exitCode})`);
  }

  // Get commit SHA
  const revRes = await runner({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: opts.worktreePath,
    timeoutMs: 5_000,
  });
  const sha = revRes.stdout.trim().slice(0, 40);

  // Push via SSH, no force
  console.log(JSON.stringify({ msg: "git push", branch: opts.branch }));
  const pushRes = await runner({
    command: "git",
    args: ["push", "origin", opts.branch],
    cwd: opts.worktreePath,
    timeoutMs: 60_000,
  });
  if (pushRes.exitCode !== 0) {
    throw new Error(`git push failed (exit ${pushRes.exitCode})`);
  }

  return sha;
}

export function isWorktreePathAllowed(worktreePath: string, dataDir?: string): boolean {
  if (!worktreePath || typeof worktreePath !== "string") return false;
  const baseDataDir = (dataDir || process.env.GHOST_DATA_DIR || "/home/rohan/.config/ghost").trim();
  const worktreesDir = join(baseDataDir, "worktrees");
  const resolvedWorktree = resolve(worktreePath);
  const resolvedWorktreesDir = resolve(worktreesDir);
  // Must be strictly inside worktreesDir, not equal, and must have prefix with separator
  if (resolvedWorktree === resolvedWorktreesDir) return false;
  // Ensure containment: must start with worktreesDir + "/"
  // Normalizes to avoid prefix tricks like /tmp/ghost-worktrees-evil
  return resolvedWorktree.startsWith(resolvedWorktreesDir + "/");
}

export async function cleanupWorktreeIfAllowed(opts: {
  targetRepoPath: string;
  worktreePath: string;
  dataDir?: string;
  runner?: typeof runCommand;
}): Promise<boolean> {
  const allowed = isWorktreePathAllowed(opts.worktreePath, opts.dataDir);
  if (!allowed) {
    console.warn(JSON.stringify({ msg: "worktree cleanup refused: path outside worktrees dir", worktreePath: opts.worktreePath }));
    return false;
  }
  const runner = wrapRunner(opts.runner || runCommand);
  try {
    console.log(JSON.stringify({ msg: "worktree cleanup start", worktreePath: opts.worktreePath }));
    const res = await runner({
      command: "git",
      args: ["worktree", "remove", "--force", opts.worktreePath],
      cwd: opts.targetRepoPath,
      timeoutMs: 15_000,
    });
    if (res.exitCode === 0) {
      console.log(JSON.stringify({ msg: "worktree cleanup success", worktreePath: opts.worktreePath }));
      return true;
    } else {
      console.warn(JSON.stringify({ msg: "worktree cleanup failed", worktreePath: opts.worktreePath, exitCode: res.exitCode }));
      return false;
    }
  } catch (err) {
    console.warn(JSON.stringify({ msg: "worktree cleanup error", worktreePath: opts.worktreePath, error: sanitizeError((err as Error).message, 300) }));
    return false;
  }
}

export async function cleanupWorktree(opts: {
  targetRepoPath: string;
  worktreePath: string;
  runner?: typeof runCommand;
}): Promise<void> {
  // Legacy wrapper — validates containment before removal
  await cleanupWorktreeIfAllowed({ targetRepoPath: opts.targetRepoPath, worktreePath: opts.worktreePath, runner: opts.runner });
}

/**
 * Remove a terminal session's local branch only when no unique work can be
 * lost: it either has no commits beyond origin/main or its tip already exists
 * on origin. This keeps failed session branches from accumulating while never
 * deleting unpublished work.
 */
export async function pruneLocalBranchIfSafe(opts: {
  targetRepoPath: string;
  branch: string;
  runner?: typeof runCommand;
}): Promise<boolean> {
  const runner = wrapRunner(opts.runner || runCommand);
  try {
    if (!opts.branch || !opts.branch.startsWith("ghost/") || opts.branch.includes("..") || opts.branch.includes(" ")) return false;
    const run = (args: string[]) =>
      runner({ command: "git", args, cwd: opts.targetRepoPath, timeoutMs: 10_000, maxOutputBytes: 50_000 });
    const local = await run(["rev-parse", "--verify", "--quiet", opts.branch]);
    if (local.exitCode !== 0 || !local.stdout.trim()) return false;
    const localTip = local.stdout.trim();
    const main = await run(["rev-parse", "--verify", "--quiet", "origin/main"]);
    if (main.exitCode === 0 && main.stdout.trim()) {
      const ahead = await run(["rev-list", "--count", `origin/main..${opts.branch}`]);
      if (!ahead.timedOut && ahead.exitCode === 0 && ahead.stdout.trim() === "0") {
        const deleted = await run(["branch", "-D", opts.branch]);
        const ok = deleted.exitCode === 0;
        console.log(JSON.stringify({ msg: ok ? "pruned empty session branch" : "prune empty session branch failed", branch: opts.branch }));
        return ok;
      }
    }
    const remote = await run(["rev-parse", "--verify", "--quiet", `origin/${opts.branch}`]);
    if (remote.exitCode === 0 && remote.stdout.trim() === localTip) {
      const deleted = await run(["branch", "-D", opts.branch]);
      const ok = deleted.exitCode === 0;
      console.log(JSON.stringify({ msg: ok ? "pruned pushed session branch" : "prune pushed session branch failed", branch: opts.branch }));
      return ok;
    }
    return false;
  } catch {
    return false;
  }
}
