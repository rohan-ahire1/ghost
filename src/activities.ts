import type { createAgentActivity, LinearTokenManager } from "./linear.js";
import type { JobStore } from "./jobStore.js";
import type { MuseResult } from "./museRunner.js";
import { sanitizeError } from "./commandRunner.js";

export function sanitizeModelString(value: string, maxLen: number): string {
  return sanitizeError(String(value || ""), maxLen);
}
function sanitizeModelArray(arr: unknown, maxLen: number, limit: number): string[] {
  if (!Array.isArray(arr)) return [];
  return (arr as unknown[]).slice(0, limit).map((v) => sanitizeError(String(v), maxLen));
}
export function sanitizeModelResult(muse: MuseResult): MuseResult {
  return {
    status: muse.status,
    summary: sanitizeError(muse.summary, 4000),
    questions: sanitizeModelArray(muse.questions, 1000, 10),
    changed_files: sanitizeModelArray(muse.changed_files, 500, 100),
    validation_performed: sanitizeModelArray(muse.validation_performed, 500, 20),
    residual_risks: sanitizeModelArray(muse.residual_risks, 1000, 20),
    wants_work: muse.wants_work === true,
  };
}
export async function postActivity(
  tokenManager: LinearTokenManager,
  sessionId: string,
  content: { type: "thought" | "action" | "response" | "error" | "elicitation"; body?: string },
  createActivityFn: typeof createAgentActivity,
): Promise<boolean> {
  try {
    const token = await tokenManager.getAuthHeader();
    if (!token) {
      console.error(JSON.stringify({ msg: "no token for activity", sessionId }));
      return false;
    }
    return await createActivityFn({
      authHeader: token,
      agentSessionId: sessionId,
      content,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        msg: "postActivity error",
        sessionId,
        error: sanitizeError((err as Error).message, 300),
      }),
    );
    return false;
  }
}
export async function sendElicitation(
  tokenManager: LinearTokenManager,
  sessionId: string,
  question: string,
  createActivityFn: typeof createAgentActivity,
): Promise<boolean> {
  return postActivity(tokenManager, sessionId, { type: "elicitation", body: question }, createActivityFn);
}

/** Persist sanitized Muse fields onto the job record. */
export async function persistMuseResult(
  jobStore: JobStore,
  sessionId: string,
  muse: MuseResult,
): Promise<void> {
  await jobStore.withSessionLock(sessionId, async () => {
    const rec = jobStore.load(sessionId);
    if (rec) {
      rec.summary = muse.summary;
      rec.questions = muse.questions;
      rec.changedFiles = muse.changed_files;
      rec.validationPerformed = muse.validation_performed;
      rec.residualRisks = muse.residual_risks;
      jobStore.save(rec);
    }
  });
}

/** Handle a blocked Muse result: persist awaiting_input and elicit. */
export async function handleBlocked(
  jobStore: JobStore,
  tokenManager: LinearTokenManager,
  sessionId: string,
  muse: MuseResult,
  createActivityFn: typeof createAgentActivity,
): Promise<void> {
  await jobStore.withSessionLock(sessionId, async () => {
    const rec = jobStore.load(sessionId);
    if (rec) {
      rec.status = "awaiting_input";
      jobStore.save(rec);
    }
  });
  const rawQuestion = muse.questions.length > 0 ? muse.questions.join("\n\n") : muse.summary;
  const safeQuestion = sanitizeModelString(rawQuestion, 4000);
  await sendElicitation(tokenManager, sessionId, safeQuestion, createActivityFn);
  console.log(JSON.stringify({ msg: "Muse blocked, awaiting input", sessionId }));
}
