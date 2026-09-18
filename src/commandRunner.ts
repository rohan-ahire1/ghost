import { spawn } from "node:child_process";
import { buildSafeEnv, redactKnownSecrets, getKnownServiceSecretValues } from "./childEnv.js";

export interface RunOptions {
  command: string;
  args: string[];
  cwd?: string;
  input?: string; // stdin
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Called with each complete stdout line as it arrives (a trailing partial
   * line is flushed on close). Callback errors are swallowed so progress
   * reporting can never break the run.
   */
  onStdoutLine?: (line: string) => void;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

/**
 * Safe command runner:
 * - Uses argv arrays, shell: false
 * - Enforces timeouts and output caps
 * - Sanitizes errors (no secrets leakage)
 * - Never interpolates task text into shell command
 */
export async function runCommand(opts: RunOptions): Promise<RunResult> {
  const {
    command,
    args,
    cwd,
    input,
    timeoutMs = 30_000,
    maxOutputBytes = 1_000_000,
    env,
  } = opts;

  // Validate command path is absolute or simple binary name, not shell injection
  if (!command || typeof command !== "string") {
    throw new Error("Invalid command");
  }
  if (command.includes(";") || command.includes("`") || command.includes("$(")) {
    throw new Error("Command contains shell metacharacters");
  }

  return new Promise<RunResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let killed = false;

    const child = spawn(command, args, {
      cwd,
      // Least-privilege: when caller does not supply an explicit env,
      // use the safe operational env (PATH, HOME, etc.) and strip all
      // service secrets (LINEAR_*, BWS_*, GITHUB_TOKEN, MODEL_API_KEY…).
      // When env is supplied it REPLACES process.env entirely (no merge).
      env: env ?? buildSafeEnv(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killed = true;
          try {
            child.kill("SIGTERM");
            // Force kill after grace
            setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {}
            }, 2000).unref();
          } catch {}
        }, timeoutMs)
      : null;

    if (input && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    } else if (child.stdin) {
      child.stdin.end();
    }

    // Helper to truncate buffer slice to valid UTF-8 boundary without exceeding byte cap
    function appendCapped(current: string, currentBytes: number, chunk: Buffer): { text: string; bytes: number; truncated: boolean } {
      const chunkBytes = chunk.length;
      if (currentBytes + chunkBytes <= maxOutputBytes) {
        return { text: current + chunk.toString("utf-8"), bytes: currentBytes + chunkBytes, truncated: false };
      }
      const remaining = maxOutputBytes - currentBytes;
      if (remaining <= 0) {
        return { text: current, bytes: currentBytes, truncated: true };
      }
      // Slice to remaining bytes, but ensure we don't cut in middle of UTF-8 sequence and then expand via replacement char
      let slice = chunk.subarray(0, remaining);
      // Find last valid UTF-8 boundary: walk back over continuation bytes (10xxxxxx)
      // UTF-8 continuation bytes are 0x80-0xBF. If we are mid-sequence, truncate to sequence start.
      let validLen = slice.length;
      // Count trailing continuation bytes
      let i = validLen - 1;
      let contCount = 0;
      while (i >= 0 && (slice[i] & 0xc0) === 0x80) {
        contCount++;
        i--;
      }
      if (i >= 0) {
        const startByte = slice[i];
        let expectedLen = 0;
        if ((startByte & 0x80) === 0) expectedLen = 1;
        else if ((startByte & 0xe0) === 0xc0) expectedLen = 2;
        else if ((startByte & 0xf0) === 0xe0) expectedLen = 3;
        else if ((startByte & 0xf8) === 0xf0) expectedLen = 4;
        else expectedLen = 1;
        const actualLen = contCount + 1;
        if (actualLen < expectedLen) {
          // Incomplete sequence at end — truncate it
          validLen = i;
        }
      } else {
        // All continuation bytes (should not happen with valid input but handle)
        validLen = 0;
      }
      if (validLen < slice.length) {
        slice = slice.subarray(0, validLen);
      }
      // Decode valid slice
      const decoded = slice.toString("utf-8");
      // Verify byte length after decode does not exceed remaining (decoded re-encoded should be <= validLen)
      // In case of replacement char issues, ensure we are within cap
      let decodedBytes = Buffer.byteLength(decoded, "utf8");
      // If due to some edge decodedBytes > remaining, trim further by chars
      let finalText = decoded;
      while (decodedBytes > remaining && finalText.length > 0) {
        finalText = finalText.slice(0, -1);
        decodedBytes = Buffer.byteLength(finalText, "utf8");
      }
      return { text: current + finalText, bytes: currentBytes + decodedBytes, truncated: true };
    }

    let lineBuf = "";
    const emitLines = (flushPartial: boolean): void => {
      if (!opts.onStdoutLine) {
        lineBuf = "";
        return;
      }
      const parts = lineBuf.split("\n");
      lineBuf = flushPartial ? "" : (parts.pop() ?? "");
      for (const part of parts) {
        if (!part) continue;
        try {
          opts.onStdoutLine(part.slice(0, 8000));
        } catch {}
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (killed) return;
      const res = appendCapped(stdout, stdoutBytes, chunk);
      stdout = res.text;
      stdoutBytes = res.bytes;
      if (res.truncated) truncated = true;
      // Ensure we mark truncated if we hit cap even when chunk exactly fills
      if (stdoutBytes >= maxOutputBytes) {
        // If further data arrives, it will be truncated; but we already flag
        // Keep bytes capped
        if (stdoutBytes > maxOutputBytes) stdoutBytes = maxOutputBytes;
      }
      if (opts.onStdoutLine) {
        lineBuf += chunk.toString("utf-8");
        if (lineBuf.length > 1_000_000) lineBuf = lineBuf.slice(-1_000_000);
        emitLines(false);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (killed) return;
      const res = appendCapped(stderr, stderrBytes, chunk);
      stderr = res.text;
      stderrBytes = res.bytes;
      if (res.truncated) truncated = true;
      if (stderrBytes > maxOutputBytes) stderrBytes = maxOutputBytes;
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(sanitizeError(`spawn error: ${err.message}`)));
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      try {
        emitLines(true);
      } catch {}
      resolve({
        stdout,
        stderr,
        exitCode: timedOut ? null : code,
        timedOut,
        truncated,
      });
    });
  });
}

export function sanitizeError(msg: string, maxLen = 800): string {
  if (!msg) return "";
  // Central safe-error handling: redact exact known service secret values
  // (LINEAR_CLIENT_SECRET, LINEAR_WEBHOOK_SECRET, BWS_ACCESS_TOKEN,
  //  GITHUB_TOKEN, GH_TOKEN, MODEL_API_KEY, OPENAI_API_KEY) as opaque
  // sentinels even without known prefixes, before any pattern redaction.
  let sanitized = redactKnownSecrets(msg);
  // Redact known token patterns
  sanitized = sanitized.replace(/ghp_[a-zA-Z0-9]+/g, "[redacted]");
  sanitized = sanitized.replace(/github_pat_[a-zA-Z0-9_]+/g, "[redacted]");
  sanitized = sanitized.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]");
  return sanitized.slice(0, maxLen);
}

export function redactWithValue(msg: string, secrets: Array<string | undefined | null>, maxLen = 800): string {
  let out = msg || "";
  // First, ensure known service secrets are covered even if caller did not list them.
  // This handles opaque sentinel values for LINEAR/BWS/GITHUB/MODEL secrets.
  out = redactKnownSecrets(out);
  for (const s of secrets) {
    if (!s || typeof s !== "string" || s.length < 4) continue;
    // Escape for literal replaceAll; fallback to split if regex fails.
    const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      out = out.replace(new RegExp(escaped, "g"), "[redacted]");
    } catch {
      out = out.split(s).join("[redacted]");
    }
  }
  return sanitizeError(out, maxLen);
}

export function getSafeErrorMessage(err: unknown): string {
  if (err instanceof Error) return sanitizeError(err.message);
  return sanitizeError(String(err));
}

export function getSafeErrorMessageWithSecrets(err: unknown, secrets: Array<string | undefined | null>): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactWithValue(raw, secrets);
}
