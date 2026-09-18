import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./fsAtomic.js";
import { sanitizeError as centralSanitizeError } from "./commandRunner.js";

export type JobStatus = "created" | "running" | "awaiting_input" | "completed" | "failed";

export interface RepoInfo {
  id: string;
  path: string;
  github: string;
}

export interface JobRecord {
  sessionId: string;
  status: JobStatus;
  /**
   * A lightweight conversation that is deliberately awaiting a concrete task.
   * It must not be treated as a completed implementation merely because the
   * initial message was a greeting.
   */
  interactionMode?: "conversation";
  issueIdentifier?: string;
  issueTitle?: string;
  promptContext?: string;
  followUps: string[];
  /**
   * How many followUps entries the current turn has consumed. A turn only
   * reads entries at index >= consumedFollowUps, so messages arriving
   * mid-turn stay pending and are picked up by the next chained turn in the
   * same session instead of being silently dropped.
   */
  consumedFollowUps?: number;
  repo?: RepoInfo;
  branch?: string;
  worktreePath?: string;
  /** "repo" = isolated git worktree, "scratch" = private per-session scratch workspace (never enters git/PR ops). */
  workspaceKind?: "repo" | "scratch";
  scratchPath?: string;
  createdAt: string;
  updatedAt: string;
  // Result fields
  summary?: string;
  questions?: string[];
  changedFiles?: string[];
  validationPerformed?: string[];
  reviewVerdict?: string;
  residualRisks?: string[];
  checks?: Array<{ name: string; ok: boolean; output?: string }>;
  commitSha?: string;
  prUrl?: string;
  compareUrl?: string;
  error?: string; // sanitized, truncated
  // original context for idempotency - not raw payload full dump
  contextHash?: string;
}

function sanitizeError(msg: string, maxLen = 800): string {
  return centralSanitizeError(msg, maxLen);
}

export function sanitizeErrorExport(msg: string, maxLen = 800): string {
  return centralSanitizeError(msg, maxLen);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {}
}

/**
 * Central helper to sanitize model-controlled string fields.
 * Uses centralSanitizeError to redact exact known secrets and pattern secrets,
 * preserving sensible field length via maxLen truncation.
 */
function sanitizeModelString(value: string, maxLen: number): string {
  if (typeof value !== "string") return "";
  return centralSanitizeError(value, maxLen);
}

function sanitizeModelArray(arr: unknown, maxLen: number, limit: number): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, limit).map((v) => centralSanitizeError(String(v), maxLen));
}

// Process-wide shared locks across JobStore instances (keyed by dataDir + id)
const globalSessionLocks = new Map<string, Promise<void>>();
const globalRepoLocks = new Map<string, Promise<void>>();

function sessionLockKey(dataDir: string, sessionId: string): string {
  return `${dataDir}::session::${sessionId}`;
}
function repoLockKey(dataDir: string, repoId: string): string {
  return `${dataDir}::repo::${repoId}`;
}

export class JobStore {
  private dataDir: string;
  private jobsDir: string;
  // Keep instance maps for backward compat but delegate to global
  private sessionLocks = new Map<string, Promise<void>>();
  private repoLocks = new Map<string, Promise<void>>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.jobsDir = join(dataDir, "jobs");
    ensureDir(this.dataDir);
    ensureDir(this.jobsDir);
  }

  private jobPath(sessionId: string): string {
    // Sanitize sessionId for filesystem
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
    return join(this.jobsDir, `${safe}.json`);
  }

  load(sessionId: string): JobRecord | null {
    const p = this.jobPath(sessionId);
    if (!existsSync(p)) return null;
    try {
      const raw = readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw) as JobRecord;
      if (!parsed.sessionId || !parsed.status) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  save(record: JobRecord): void {
    const now = new Date().toISOString();
    // Defense in depth: sanitize every model-controlled field before persisting.
    // Do not mutate caller arrays unexpectedly — build sanitized copy for persistence.
    const toPersist: JobRecord = {
      ...record,
      updatedAt: now,
      followUps: record.followUps ? [...record.followUps] : [],
      ...(record.questions ? { questions: [...record.questions] } : {}),
      ...(record.changedFiles ? { changedFiles: [...record.changedFiles] } : {}),
      ...(record.validationPerformed ? { validationPerformed: [...record.validationPerformed] } : {}),
      ...(record.residualRisks ? { residualRisks: [...record.residualRisks] } : {}),
      ...(record.checks ? { checks: record.checks.map((c) => ({ ...c })) } : {}),
    };
    if (toPersist.error) toPersist.error = sanitizeModelString(toPersist.error, 800);
    if (toPersist.summary) toPersist.summary = sanitizeModelString(toPersist.summary, 4000);
    if (toPersist.questions) toPersist.questions = sanitizeModelArray(toPersist.questions, 1000, 10);
    if (toPersist.changedFiles) toPersist.changedFiles = sanitizeModelArray(toPersist.changedFiles, 500, 100);
    if (toPersist.validationPerformed) toPersist.validationPerformed = sanitizeModelArray(toPersist.validationPerformed, 500, 20);
    if (toPersist.reviewVerdict) toPersist.reviewVerdict = sanitizeModelString(toPersist.reviewVerdict, 50);
    if (toPersist.residualRisks) toPersist.residualRisks = sanitizeModelArray(toPersist.residualRisks, 1000, 20);
    if (toPersist.checks) {
      toPersist.checks = toPersist.checks!.map((c) => ({
        name: sanitizeModelString(String(c.name), 200),
        ok: c.ok,
        output: c.output ? sanitizeModelString(String(c.output), 800) : undefined,
      }));
    }
    // Update caller's updatedAt for expected side-effect, but avoid mutating caller's model arrays
    record.updatedAt = now;
    atomicWriteJson(this.jobPath(record.sessionId), toPersist);
  }

  create(record: JobRecord): boolean {
    // Fail if already exists (idempotency) — atomic check via exists
    // We use write with check: if exists, return false
    const p = this.jobPath(record.sessionId);
    if (existsSync(p)) return false;
    // Ensure we don't race with another process: use tmp unique then link with exclusive?
    // Simplified: double-check after mkdir and before write with existsSync, still race window but mitigated by per-session lock.
    // Use atomicWrite but only if not exists — we need exclusive.
    try {
      // Try to open with 'wx' equivalent via writeFileSync with flag
      const content = JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2);
      // Node's writeFileSync supports flag 'wx' to fail if exists
      writeFileSync(p, content, { mode: 0o600, flag: "wx" });
      try {
        chmodSync(p, 0o600);
      } catch {}
      return true;
    } catch (e: any) {
      if (e && e.code === "EEXIST") return false;
      // If other error, treat as failure to create; maybe file was created concurrent
      if (existsSync(p)) return false;
      throw e;
    }
  }

  listAll(): JobRecord[] {
    try {
      const files = readdirSync(this.jobsDir);
      const out: JobRecord[] = [];
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const sessionId = f.replace(/\.json$/, "").replace(/_/g, "-"); // approximate; but we need to load via path
        const full = join(this.jobsDir, f);
        try {
          const raw = readFileSync(full, "utf-8");
          const parsed = JSON.parse(raw) as JobRecord;
          if (parsed.sessionId) out.push(parsed);
          else {
            // fallback: use filename
            void sessionId;
          }
        } catch {}
      }
      return out;
    } catch {
      return [];
    }
  }

  // In-memory lock helpers — now process-wide
  async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.withGlobalLock(globalSessionLocks, sessionLockKey(this.dataDir, sessionId), fn);
  }

  async withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    return this.withGlobalLock(globalRepoLocks, repoLockKey(this.dataDir, repoId), fn);
  }

  private async withGlobalLock<T>(locks: Map<string, Promise<void>>, key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) || Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((res) => (release = res));
    const wait = prev.catch(() => {});
    locks.set(key, next);
    await wait;
    try {
      const result = await fn();
      return result;
    } finally {
      release!();
      if (locks.get(key) === next) locks.delete(key);
    }
  }

  private async withLock<T>(locks: Map<string, Promise<void>>, key: string, fn: () => Promise<T>): Promise<T> {
    // Legacy instance-local fallback (not used by withSession/withRepo anymore, kept for coverage)
    const prev = locks.get(key) || Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((res) => (release = res));
    // Chain: wait for previous, then run
    const wait = prev.catch(() => {});
    locks.set(key, next);

    await wait;
    try {
      const result = await fn();
      return result;
    } finally {
      // Release lock
      release!();
      // Clean up if no newer waiter replaced us
      if (locks.get(key) === next) locks.delete(key);
    }
  }

  // Convenience: check if job is duplicate (should not start twice)
  isDuplicateCreated(sessionId: string): boolean {
    const existing = this.load(sessionId);
    if (!existing) return false;
    // Any existing status means duplicate should not start new work
    // Per spec: duplicate created deliveries must not start job twice, including after restart
    // So if job already exists in any terminal or running state, it's duplicate
    return ["created", "running", "awaiting_input", "completed", "failed"].includes(existing.status);
  }

  appendFollowUp(sessionId: string, body: string): JobRecord | null {
    const rec = this.load(sessionId);
    if (!rec) return null;
    const truncated = body.slice(0, 8000);
    rec.followUps.push(truncated);
    rec.updatedAt = new Date().toISOString();
    this.save(rec);
    return rec;
  }

  // For tests: clear in-memory locks
  clearLocks(): void {
    this.sessionLocks.clear();
    this.repoLocks.clear();
    // Also clear global locks for this dataDir
    for (const k of Array.from(globalSessionLocks.keys())) {
      if (k.startsWith(`${this.dataDir}::session::`)) globalSessionLocks.delete(k);
    }
    for (const k of Array.from(globalRepoLocks.keys())) {
      if (k.startsWith(`${this.dataDir}::repo::`)) globalRepoLocks.delete(k);
    }
  }
}
