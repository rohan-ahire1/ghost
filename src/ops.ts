import { JobStore, type JobRecord } from "./jobStore.js";

export interface JobSummary {
  sessionId: string;
  status: JobRecord["status"];
  issueIdentifier?: string;
  issueTitle?: string;
  repo?: string;
  branch?: string;
  workspaceKind?: string;
  createdAt: string;
  updatedAt: string;
  summary?: string;
  error?: string;
  prUrl?: string;
  compareUrl?: string;
  commitSha?: string;
  followUpCount: number;
  pendingFollowUps: number;
  validationPerformed?: string[];
}

/** Loopback-only view of a job: status metadata without prompt bodies. */
export function summarizeJob(rec: JobRecord): JobSummary {
  const followUps = rec.followUps || [];
  const consumed = rec.consumedFollowUps || 0;
  return {
    sessionId: rec.sessionId,
    status: rec.status,
    issueIdentifier: rec.issueIdentifier,
    issueTitle: rec.issueTitle,
    repo: rec.repo?.id,
    branch: rec.branch,
    workspaceKind: rec.workspaceKind,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    summary: rec.summary,
    error: rec.error,
    prUrl: rec.prUrl,
    compareUrl: rec.compareUrl,
    commitSha: rec.commitSha,
    followUpCount: followUps.length,
    pendingFollowUps: Math.max(0, followUps.length - consumed),
    validationPerformed: rec.validationPerformed,
  };
}

export interface JobDetail extends JobSummary {
  questions?: string[];
  changedFiles?: string[];
  checks?: Array<{ name: string; ok: boolean }>;
  residualRisks?: string[];
  scratchPath?: string;
  worktreePath?: string;
}

/** Detail view: everything except promptContext and follow-up bodies. */
export function detailJob(rec: JobRecord): JobDetail {
  return {
    ...summarizeJob(rec),
    questions: rec.questions,
    changedFiles: rec.changedFiles,
    checks: rec.checks?.map((c) => ({ name: c.name, ok: c.ok })),
    residualRisks: rec.residualRisks,
    scratchPath: rec.scratchPath,
    worktreePath: rec.worktreePath,
  };
}

export interface OpsSnapshot {
  service: "ghost";
  startedAt: string;
  uptimeMs: number;
  jobs: { total: number; byStatus: Record<string, number> };
  lastFailure?: { sessionId: string; issueIdentifier?: string; error?: string; updatedAt: string };
  recent: JobSummary[];
}

export function getOpsSnapshot(jobStore: JobStore, startedAt: Date, nowMs = Date.now()): OpsSnapshot {
  const all = jobStore
    .listAll()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const byStatus: Record<string, number> = {};
  for (const rec of all) byStatus[rec.status] = (byStatus[rec.status] || 0) + 1;
  const lastFailed = all.find((r) => r.status === "failed");
  return {
    service: "ghost",
    startedAt: startedAt.toISOString(),
    uptimeMs: Math.max(0, nowMs - startedAt.getTime()),
    jobs: { total: all.length, byStatus },
    ...(lastFailed
      ? {
          lastFailure: {
            sessionId: lastFailed.sessionId,
            issueIdentifier: lastFailed.issueIdentifier,
            error: lastFailed.error,
            updatedAt: lastFailed.updatedAt,
          },
        }
      : {}),
    recent: all.slice(0, 20).map(summarizeJob),
  };
}
