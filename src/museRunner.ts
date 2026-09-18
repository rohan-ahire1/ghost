import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommand } from "./commandRunner.js";
import { sanitizeError } from "./commandRunner.js";
import { buildMuseEnv } from "./childEnv.js";

/**
 * Direct Muse invocation for a Linear AgentSession request.
 *
 * One Muse process per request: `muse exec --json` with provider `meta` and
 * model exactly `muse-spark-1.3-contributor`. Muse emits JSONL; the parser
 * treats JSONL as its primary contract. No other model, no nested
 * orchestrator skill, and no dynamically generated sandbox config.
 */

export const MUSE_BIN_DEFAULT = "/home/rohan/.local/bin/muse";
export const MUSE_PROVIDER = "meta";
export const MUSE_MODEL = "muse-spark-1.3-contributor";
export const MUSE_REASONING_EFFORT = "high";
export const MUSE_MAX_MODEL_STEPS = "50";
// Questions/answers run in scratch workspaces and need far less deliberation
// than repo work (plus fewer tool steps — Q&A rarely needs more than a few
// read-only calls). Compute budget only; the same model gets the full prompt
// and full latitude either way.
export const MUSE_QUICK_REASONING_EFFORT = "low";
export const MUSE_QUICK_MAX_MODEL_STEPS = "15";

export interface MuseResult {
  status: "completed" | "blocked";
  summary: string;
  questions: string[];
  changed_files: string[];
  validation_performed: string[];
  residual_risks: string[];
}

export interface MuseRunOptions {
  workspace: string;
  prompt: string;
  timeoutMs?: number;
  // For dependency injection / tests
  runner?: typeof runCommand;
  /** Override prompt-file path (tests). When omitted, a 0600 temp file is used. */
  promptFilePath?: string;
  museBin?: string;
  maxModelSteps?: number;
  /** Override --reasoning-effort (defaults to MUSE_REASONING_EFFORT). */
  reasoningEffort?: string;
  /** Called with each raw stdout line as it arrives (for live progress). */
  onProgressLine?: (line: string) => void;
}

/**
 * Turns `muse exec --json` JSONL progress lines into short human feed items.
 * Stateful: tool `started`/`completed` events carry only a task id, so the
 * tool name is learned from the earlier `proposed` event for that id.
 * Returns null for anything that is not post-worthy (deltas, provider
 * plumbing, reminders, unknown shapes). Only tool names flow through — never
 * model output, so no secrets can leak into the feed.
 */
export class ProgressTracker {
  private tools = new Map<string, string>();

  feedLine(line: string): string | null {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      return null;
    }
    const event = obj?.payload?.event;
    if (!event || typeof event !== "object") return null;
    const kind = event.kind;
    const taskId = typeof event.task_id === "string" ? event.task_id : "";
    if (kind === "proposed" && typeof event.task_kind === "string" && event.task_kind.startsWith("tool.")) {
      if (taskId) {
        if (this.tools.size > 500) this.tools.clear();
        this.tools.set(taskId, event.task_kind.slice("tool.".length).slice(0, 40));
      }
      return null;
    }
    if ((kind === "started" || kind === "completed" || kind === "failed") && taskId) {
      const tool = this.tools.get(taskId);
      if (!tool) return null;
      const detail = typeof event.label === "string" && event.label.trim() !== ""
        ? ` ${event.label.trim().slice(0, 80)}`
        : "";
      if (kind === "started") return `▶ ${tool}${detail}`;
      if (kind === "completed") return `✓ ${tool}`;
      return `✗ ${tool}`;
    }
    return null;
  }
}

export interface ProgressPosterOpts {
  minMs?: number;
  maxPosts?: number;
  now?: () => number;
}

/**
 * Throttled, capped sink for tracker items: first item posts immediately,
 * then at most one per minMs, at most maxPosts total.
 */
export function createProgressPoster(
  tracker: ProgressTracker,
  post: (body: string) => void,
  opts: ProgressPosterOpts = {},
): (line: string) => void {
  const minMs = opts.minMs ?? 12_000;
  const maxPosts = opts.maxPosts ?? 25;
  const now = opts.now ?? Date.now;
  let posts = 0;
  let last = 0;
  return (line: string) => {
    if (posts >= maxPosts) return;
    const item = tracker.feedLine(line);
    if (!item) return;
    const t = now();
    if (posts > 0 && t - last < minMs) return;
    posts++;
    last = t;
    try {
      post(item);
    } catch {}
  };
}

export function getMuseBin(): string {
  return (process.env.GHOST_MUSE_BIN || MUSE_BIN_DEFAULT).trim();
}

export function getMuseTimeoutMs(): number {
  const raw = process.env.GHOST_MUSE_TIMEOUT_MS || "600000";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 600_000;
}

/**
 * Exact argv array for the Muse child process. Must stay in sync with the
 * documented invocation: `exec --json` for the JSONL contract, provider
 * `meta`, model exactly `muse-spark-1.3-contributor`, required safety flags
 * only — no --yolo, no --disable-sandbox, no sandbox flags, no broad
 * credentials, no other model.
 */
export function buildMuseArgs(params: {
  workspace: string;
  promptFile: string;
  maxModelSteps?: number;
  reasoningEffort?: string;
}): string[] {
  return [
    "exec",
    "--json",
    "--workspace",
    params.workspace,
    "--prompt-file",
    params.promptFile,
    "--provider",
    MUSE_PROVIDER,
    "--model",
    MUSE_MODEL,
    "--reasoning-effort",
    params.reasoningEffort ?? MUSE_REASONING_EFFORT,
    "--parallel-tool-calls",
    "--trust-workspace",
    "--no-foreign-personal-context",
    "--approval-mode",
    "never",
    "--no-session-log",
    "--approval-judge",
    "off",
    "--max-model-steps",
    String(params.maxModelSteps ?? Number(MUSE_MAX_MODEL_STEPS)),
  ];
}

export function buildMusePrompt(params: {
  issueIdentifier?: string;
  issueTitle?: string;
  promptContext?: string;
  followUps?: string[];
  repoId?: string;
  branch?: string;
  /** "repo" when running in an isolated git worktree, "scratch" otherwise. */
  workspaceKind: "repo" | "scratch";
  workspacePath?: string;
  /** Repository ids that ambiguously matched (or empty when none matched). */
  candidates?: string[];
  /** Short human-readable resolution note, e.g. "multiple repos matched: a, b". */
  resolutionReason?: string;
  /** The user message that triggered this session, when Linear supplied it. */
  directive?: string;
  /**
   * One-place worktree convention, rendered only for repo workspaces so the
   * model knows how/where to create a worktree when the user asks for one.
   * Ghost itself never creates worktrees unprompted beyond this session's.
   */
  worktreeHint?: string;
}): string {
  const {
    issueIdentifier,
    issueTitle,
    promptContext,
    followUps,
    repoId,
    branch,
    workspaceKind,
    workspacePath,
    candidates,
    resolutionReason,
    directive,
    worktreeHint,
  } = params;
  const lines: string[] = [];

  lines.push(
    "You are Muse Code (Muse Spark), working a Linear agent task directly in this workspace.",
  );
  lines.push("");
  if (workspaceKind === "repo") {
    lines.push(
      `You are inside an isolated git worktree${workspacePath ? ` at ${workspacePath}` : ""} for repository "${repoId || "unknown"}"${branch ? ` on branch "${branch}" (already created — do not create another branch)` : ""}.`,
    );
    lines.push(
      "Make exactly the file edits the task needs, or answer without editing files when no change is needed.",
    );
    if (worktreeHint) {
      lines.push(worktreeHint.slice(0, 800));
    }
  } else {
    lines.push(
      "You are inside a private per-session scratch workspace. No single repository was resolved for this task, so there is nothing to commit or push.",
    );
    if (resolutionReason) {
      lines.push(`Repository resolution: ${resolutionReason.slice(0, 500)}.`);
    }
    if (candidates && candidates.length > 0) {
      lines.push(
        `Candidate repositories: ${candidates.slice(0, 10).join(", ")}.`,
      );
      lines.push(
        "This request may span repositories — for example, summarize the ticket directly without editing files when no change is needed.",
      );
    }
    lines.push(
      "Answer read/summary/general questions directly without editing files when possible. If the task genuinely requires modifying a repository, do NOT edit scratch files as a substitute — return blocked and ask which repository to use.",
    );
  }
  lines.push("");
  if (directive) {
    lines.push("The user's actual request (prioritize this over the issue history below):");
    lines.push(">>>");
    lines.push(directive.slice(0, 2000));
    lines.push(">>>");
    lines.push("");
  }
  lines.push("Task context:");
  if (issueIdentifier)
    lines.push(
      `- Issue: ${issueIdentifier}${issueTitle ? ` — ${issueTitle}` : ""}`,
    );
  else if (issueTitle) lines.push(`- Title: ${issueTitle}`);
  if (repoId) lines.push(`- Repository: ${repoId}`);
  if (branch) lines.push(`- Target branch: ${branch}`);
  lines.push("");
  if (promptContext) {
    lines.push("Original task prompt:");
    lines.push("```");
    lines.push(promptContext.slice(0, 20000));
    lines.push("```");
    lines.push("");
  }
  if (followUps && followUps.length > 0) {
    lines.push("Follow-up inputs from user (append these to task understanding):");
    for (let i = 0; i < followUps.length; i++) {
      lines.push(`--- Follow-up ${i + 1} ---`);
      lines.push(followUps[i].slice(0, 8000));
    }
    lines.push("");
  }
  lines.push("How to respond:");
  lines.push(
    "- If the request is a question, greeting, or smalltalk: answer it directly in a sentence or two and stop. Never mention the issue, worktrees, branches, or completion; never ask what the user wants to work on; never introduce yourself or name the model.",
  );
  lines.push(
    "- For anything else needing no file change: answer directly, editing nothing.",
  );
  lines.push(
    "- To implement/fix/build: edit files in this workspace only, keeping changes focused and consistent with existing style.",
  );
  lines.push(
    "- If you are blocked by missing information: return blocked with concise questions.",
  );
  lines.push("- Do not commit, push, create PRs, or deploy — the host owns git operations. Only modify files in the workspace.");
  lines.push(
    "- Run checks yourself where useful and report what validation you performed.",
  );
  lines.push("");
  lines.push(
    "Output: Return ONLY the strict JSON object with keys status (completed|blocked), summary (string), questions (string[]), changed_files (string[]), validation_performed (string[]), residual_risks (string[]). No extra prose outside JSON.",
  );

  return lines.join("\n");
}

/**
 * Parse Muse JSONL output defensively and extract the final structured result.
 * Muse emits JSONL progress events (assistant/tool/status lines); we must not
 * assume a single shape and instead hunt for the result object.
 */
export function parseMuseJsonl(stdout: string): MuseResult | null {
  if (!stdout.trim()) return null;

  const candidates: MuseResult[] = [];

  // First, try to split as JSONL lines
  const lines = stdout.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      const found = deepFindMuseResult(obj);
      if (found) candidates.push(found);
      if (isMuseResult(obj)) candidates.push(obj);
    } catch {
      // Not a JSON line, ignore
    }
  }

  // If still none, try parsing entire stdout as JSON (single object or array)
  if (candidates.length === 0) {
    try {
      const obj = JSON.parse(stdout);
      const found = deepFindMuseResult(obj);
      if (found) candidates.push(found);
      if (isMuseResult(obj)) candidates.push(obj);
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const f = deepFindMuseResult(item);
          if (f) candidates.push(f);
        }
      }
    } catch {}
  }

  // Also attempt to extract JSON blob from mixed output (e.g., prose + JSON)
  if (candidates.length === 0) {
    const jsonBlobs = extractJsonBlobs(stdout);
    for (const blob of jsonBlobs) {
      try {
        const obj = JSON.parse(blob);
        const found = deepFindMuseResult(obj);
        if (found) candidates.push(found);
        if (isMuseResult(obj)) candidates.push(obj);
      } catch {}
    }
  }

  if (candidates.length === 0) return null;
  // Prefer last candidate (final)
  return candidates[candidates.length - 1];
}

function isMuseResult(obj: any): obj is MuseResult {
  if (!obj || typeof obj !== "object") return false;
  return (
    (obj.status === "completed" || obj.status === "blocked") &&
    typeof obj.summary === "string" &&
    Array.isArray(obj.questions) &&
    Array.isArray(obj.changed_files) &&
    Array.isArray(obj.validation_performed) &&
    Array.isArray(obj.residual_risks)
  );
}

function deepFindMuseResult(obj: any, depth = 0): MuseResult | null {
  if (depth > 6 || obj === null || typeof obj !== "object") return null;
  if (isMuseResult(obj)) return obj;

  // Common wrapper keys a Muse JSONL envelope might use
  const wrapperKeys = [
    "result",
    "output",
    "structured_output",
    "final",
    "response",
    "payload",
    "data",
    "content",
    "message",
    "text",
    "value",
    "item",
  ];

  for (const k of wrapperKeys) {
    if (obj[k] && typeof obj[k] === "object") {
      if (isMuseResult(obj[k])) return obj[k];
      const nested = deepFindMuseResult(obj[k], depth + 1);
      if (nested) return nested;
    }
    if (typeof obj[k] === "string") {
      try {
        const parsed = JSON.parse(obj[k]);
        const f = deepFindMuseResult(parsed, depth + 1);
        if (f) return f;
        if (isMuseResult(parsed)) return parsed;
      } catch {}
    }
  }

  // Generic recursion over object values
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const f = deepFindMuseResult(v, depth + 1);
      if (f) return f;
    } else if (typeof v === "string") {
      const t = v.trim();
      if (t.startsWith("{") && t.endsWith("}")) {
        try {
          const parsed = JSON.parse(t);
          if (isMuseResult(parsed)) return parsed;
          const f = deepFindMuseResult(parsed, depth + 1);
          if (f) return f;
        } catch {}
      }
    }
  }
  return null;
}

function extractJsonBlobs(text: string): string[] {
  const blobs: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    } else {
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0 && start !== -1) {
          blobs.push(text.slice(start, i + 1));
          start = -1;
        } else if (depth < 0) {
          depth = 0;
          start = -1;
        }
      }
    }
  }
  return blobs;
}

export async function runMuse(opts: MuseRunOptions): Promise<MuseResult> {
  const runner = opts.runner || runCommand;
  const museBin = opts.museBin || getMuseBin();

  // Prompt travels via a 0600 temp file (never on the command line, never in
  // the workspace where it could pollute the git diff). Auto-created temp
  // files/directories hold ticket text and are always removed in the finally
  // block below once the Muse process returns or throws.
  let promptFile = opts.promptFilePath;
  let createdPromptDir: string | null = null;
  if (!promptFile) {
    const dir = mkdtempSync(join(tmpdir(), "ghost-muse-"));
    createdPromptDir = dir;
    try {
      chmodSync(dir, 0o700);
    } catch {}
    promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, opts.prompt, { mode: 0o600 });
    try {
      chmodSync(promptFile, 0o600);
    } catch {}
  }
  const cleanupPromptFile = (): void => {
    if (!createdPromptDir) return;
    try {
      rmSync(createdPromptDir, { recursive: true, force: true });
    } catch {}
  };

  const args = buildMuseArgs({
    workspace: opts.workspace,
    promptFile,
    maxModelSteps: opts.maxModelSteps,
    reasoningEffort: opts.reasoningEffort,
  });

  const timeoutMs = opts.timeoutMs ?? getMuseTimeoutMs();

  // Avoid logging prompt, tokens, env values — only safe metadata
  console.log(
    JSON.stringify({
      msg: "Muse start",
      workspace: opts.workspace,
      provider: MUSE_PROVIDER,
      model: MUSE_MODEL,
      reasoningEffort: opts.reasoningEffort ?? MUSE_REASONING_EFFORT,
      promptLength: opts.prompt.length,
      timeoutMs,
    }),
  );

  // Least-privilege env for Muse: safe operational vars + MODEL_API_KEY only.
  // Linear/BWS/GitHub secrets are never passed. See childEnv allowlist.
  const museEnv = buildMuseEnv();

  const onProgressLine = opts.onProgressLine;
  let result: Awaited<ReturnType<typeof runner>>;
  try {
    result = await runner({
      command: museBin,
      args,
      input: undefined,
      timeoutMs,
      maxOutputBytes: 2_000_000,
      env: museEnv,
      onStdoutLine: onProgressLine
        ? (line: string) => {
          try {
            onProgressLine(line);
          } catch {}
        }
        : undefined,
    });
  } finally {
    cleanupPromptFile();
  }

  if (result.timedOut) {
    throw new Error(`Muse timed out after ${timeoutMs}ms`);
  }

  // Avoid logging full output that may contain secrets — safe metadata only
  console.log(
    JSON.stringify({
      msg: "Muse finished",
      exitCode: result.exitCode,
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
      truncated: result.truncated,
    }),
  );

  const parsed = parseMuseJsonl(result.stdout);
  if (!parsed) {
    // Defensive: some runners log JSONL to stderr
    const parsedStderr = parseMuseJsonl(result.stderr);
    if (parsedStderr) return parsedStderr;

    // Degraded mode: the model answered in prose (or was cut off) without
    // the strict JSON object. Synthesize a completed result from the raw
    // reply so the session still posts a response instead of failing with
    // nothing to show. Downstream gates still apply: no worktree changes
    // means answer-only, real changes still go through validation/commit.
    // Only throw when there is literally no text.
    const fallback = extractFallbackText(result.stdout);
    if (fallback) {
      console.log(
        JSON.stringify({ msg: "Muse degraded mode: prose without structured JSON", fallbackLength: fallback.length }),
      );
      return {
        status: "completed",
        summary: fallback,
        questions: [],
        changed_files: [],
        validation_performed: [],
        residual_risks: ["Ghost degraded mode: Muse returned prose instead of structured JSON; summary taken from raw reply."],
      };
    }

    const safeStderr = sanitizeError(result.stderr.slice(0, 500), 500);
    throw new Error(
      `Muse did not return structured output (exit ${result.exitCode}). stderr: ${safeStderr}`,
    );
  }

  return parsed;
}

/**
 * Best-effort prose extraction when the model answered but emitted no
 * structured JSON (e.g. a confused reply to contradictory ticket text, or a
 * run cut off at max-model-steps). Prefers the terminal event's full text,
 * then joined streaming deltas, then raw non-JSONL output. Returns "" when
 * there is genuinely no text to show.
 */
export function extractFallbackText(stdout: string): string {
  const CAP = 4000;
  if (!stdout || !stdout.trim()) return "";
  let terminalText = "";
  const deltas: string[] = [];
  let anyJsonl = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      anyJsonl = true;
      const payload = (obj as any)?.payload;
      const text = payload?.text;
      if (typeof text !== "string" || text.length === 0) continue;
      if (typeof (obj as any)?.payload_type === "string" && (obj as any).payload_type.startsWith("run.terminal.")) {
        terminalText = text;
      } else if ((obj as any)?.payload_type === "run.output.delta") {
        if (deltas.join("").length < CAP) deltas.push(text);
      }
    } catch {
      // Not a JSON line — handled by the raw-output fallback below
    }
  }
  if (terminalText.trim()) return terminalText.trim().slice(0, CAP);
  const joined = deltas.join("").trim();
  if (joined) return joined.slice(0, CAP);
  if (!anyJsonl) return stdout.trim().slice(0, CAP);
  // JSONL envelope with no text payloads (e.g. failed terminal with no text)
  return "";
}

export function validateMuseResult(obj: any): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!obj || typeof obj !== "object") {
    errors.push("result is not an object");
    return { ok: false, errors };
  }
  if (obj.status !== "completed" && obj.status !== "blocked")
    errors.push("status must be completed or blocked");
  if (typeof obj.summary !== "string") errors.push("summary must be string");
  if (!Array.isArray(obj.questions)) errors.push("questions must be array");
  if (!Array.isArray(obj.changed_files))
    errors.push("changed_files must be array");
  if (!Array.isArray(obj.validation_performed))
    errors.push("validation_performed must be array");
  if (!Array.isArray(obj.residual_risks))
    errors.push("residual_risks must be array");
  return { ok: errors.length === 0, errors };
}
