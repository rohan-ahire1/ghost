import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommand } from "./commandRunner.js";
import { buildMuseEnv } from "./childEnv.js";
import { buildMuseArgs, getMuseBin, getMuseTimeoutMs, MUSE_QUICK_REASONING_EFFORT, MUSE_QUICK_MAX_MODEL_STEPS } from "./museRunner.js";
import { museLimiter } from "./limiter.js";

/**
 * Chat gate: the front door for every message. It sees ONLY the user's
 * message, the ticket id, and recent conversation turns — never the ticket
 * body. It answers one question: small talk (reply now) or does this need
 * the ticket (fetch)? Fail-closed: anything unparseable is chat, never work.
 */
export interface ChatGate {
  mode: "chat" | "fetch";
  reply: string;
}

export interface ChatRunOptions {
  workspace: string;
  ticketId?: string;
  message: string;
  history?: string[];
  timeoutMs?: number;
  runner?: typeof runCommand;
  museBin?: string;
}

const HISTORY_TURNS = 6;
const HISTORY_CHARS = 3000;

export function buildChatPrompt(params: { ticketId?: string; message: string; history?: string[] }): string {
  const lines: string[] = [];
  lines.push("You are Ghost, a friendly assistant inside a Linear ticket thread.");
  lines.push("");
  if (params.ticketId) lines.push(`Ticket: ${params.ticketId.slice(0, 40)}`);
  const history = (params.history || []).filter((h) => typeof h === "string" && h.trim()).slice(-HISTORY_TURNS);
  if (history.length > 0) {
    lines.push("Recent conversation:");
    lines.push(history.join("\n").slice(0, HISTORY_CHARS));
    lines.push("");
  }
  lines.push("The user's message:");
  lines.push(">>>");
  lines.push(params.message.slice(0, 4000));
  lines.push(">>>");
  lines.push("");
  lines.push("Decide: is this small talk you can answer directly (greetings, thanks, general questions needing no ticket), or does it need the ticket details (work requests, questions about the ticket, follow-ups on earlier work)?");
  lines.push('Output ONLY strict JSON: {"mode": "chat" | "fetch", "reply": string}.');
  lines.push('For "chat", put your full reply in "reply" (a sentence or two, natural tone). For "fetch", "reply" is "" — the ticket will be loaded next and you will see it then.');
  return lines.join("\n");
}

/** Build the recent-turn history from a job record. User texts + last reply. */
export function buildHistory(followUps: string[], consumed: number, summary?: string): string[] {
  const out: string[] = [];
  for (const text of (followUps || []).slice(0, consumed).slice(-HISTORY_TURNS)) {
    if (typeof text === "string" && text.trim()) out.push(`user: ${text.trim().slice(0, 800)}`);
  }
  if (summary && summary.trim()) out.push(`ghost: ${summary.trim().slice(0, 800)}`);
  return out.slice(-HISTORY_TURNS);
}

export function parseChatGate(stdout: string, opts: { allowProse?: boolean } = {}): ChatGate | null {
  const allowProse = opts.allowProse !== false;
  if (!stdout || !stdout.trim()) return null;
  const blobs: string[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (t.startsWith("{") && t.endsWith("}")) blobs.push(t);
  }
  if (blobs.length === 0 && !stdout.includes("{")) {
    if (!allowProse) return null;
    const prose = stdout.trim().slice(0, 4000);
    return prose ? { mode: "chat", reply: prose } : null;
  }
  for (let i = blobs.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(blobs[i]) as { mode?: unknown; reply?: unknown };
      const found = findGate(obj) || (isGateShape(obj) ? obj : null);
      if (found) {
        const mode = found.mode === "fetch" ? "fetch" : "chat";
        const reply = typeof found.reply === "string" ? found.reply.slice(0, 4000) : "";
        return { mode, reply };
      }
    } catch {}
  }
  // JSON present but no gate object: fall back to raw prose as a chat reply.
  if (!allowProse) return null;
  const prose = extractProse(stdout);
  return prose ? { mode: "chat", reply: prose } : null;
}

function isGateShape(obj: any): obj is { mode: unknown; reply: unknown } {
  return !!obj && typeof obj === "object" && typeof obj.mode === "string" && typeof obj.reply === "string";
}

function findGate(obj: any, depth = 0): { mode: unknown; reply: unknown } | null {
  if (depth > 4 || obj === null || typeof obj !== "object") return null;
  if (isGateShape(obj)) return obj;
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const f = findGate(v, depth + 1);
      if (f) return f;
    } else if (typeof v === "string") {
      const t = v.trim();
      if (t.startsWith("{") && t.endsWith("}")) {
        try {
          const parsed = JSON.parse(t);
          if (isGateShape(parsed)) return parsed;
          const f = findGate(parsed, depth + 1);
          if (f) return f;
        } catch {}
      }
    }
  }
  return null;
}

function extractProse(stdout: string): string {
  const lines: string[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      JSON.parse(t);
    } catch {
      lines.push(t);
    }
  }
  return lines.join("\n").trim().slice(0, 4000);
}

export async function runChatGate(opts: ChatRunOptions): Promise<ChatGate> {
  const runner = opts.runner || runCommand;
  const museBin = opts.museBin || getMuseBin();
  const prompt = buildChatPrompt({ ticketId: opts.ticketId, message: opts.message, history: opts.history });

  const dir = mkdtempSync(join(tmpdir(), "ghost-chat-"));
  try {
    chmodSync(dir, 0o700);
  } catch {}
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, prompt, { mode: 0o600 });

  const args = buildMuseArgs({
    workspace: opts.workspace,
    promptFile,
    maxModelSteps: Number(MUSE_QUICK_MAX_MODEL_STEPS),
    reasoningEffort: MUSE_QUICK_REASONING_EFFORT,
  });
  const timeoutMs = opts.timeoutMs ?? getMuseTimeoutMs();

  console.log(JSON.stringify({ msg: "chat gate start", workspace: opts.workspace, promptLength: prompt.length }));
  let result: Awaited<ReturnType<typeof runner>>;
  try {
    result = await museLimiter.run(() =>
      runner({ command: museBin, args, timeoutMs, maxOutputBytes: 500_000, env: buildMuseEnv() }),
    );
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  if (result.timedOut) throw new Error(`chat gate timed out after ${timeoutMs}ms`);
  // Some runners log JSONL to stderr: accept a JSON gate from there, but
  // never treat stderr prose (usually error text) as a chat reply.
  const gate = parseChatGate(result.stdout) || parseChatGate(result.stderr, { allowProse: false });
  if (!gate) {
    throw new Error(`chat gate returned no usable reply (exit ${result.exitCode})`);
  }
  console.log(JSON.stringify({ msg: "chat gate result", mode: gate.mode }));
  return gate;
}
