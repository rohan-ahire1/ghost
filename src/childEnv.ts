/**
 * Central environment builder for child processes — least-privilege.
 *
 * Ghost runs under `bws run` so `process.env` contains:
 *   LINEAR_CLIENT_SECRET, LINEAR_WEBHOOK_SECRET,
 *   BWS_ACCESS_TOKEN,
 *   GITHUB_TOKEN / GH_TOKEN,
 *   MODEL_API_KEY (and potentially OPENAI_API_KEY).
 *
 * `runCommand` must never default to the entire `process.env`;
 * repository commands and model-invoked tools must not inherit unrelated service secrets.
 *
 * Design:
 * - buildSafeEnv(): operational vars only, strips all service secrets by default.
 * - buildMuseEnv(): safe env + the one explicitly allowed model credential.
 *
 * Node's `spawn` with `env` supplied REPLACES the parent environment (does not merge).
 * All child spawns therefore receive only the constructed env.
 */

/**
 * Known service secret keys whose exact values must be redacted and stripped.
 * Exact opaque values for these keys are redacted from logs, persisted errors,
 * and Linear messages via redactKnownSecrets().
 */
export const KNOWN_SERVICE_SECRET_ENV_KEYS = [
  "LINEAR_CLIENT_SECRET",
  "LINEAR_API_KEY",
  "LINEAR_WEBHOOK_SECRET",
  "BWS_ACCESS_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "MODEL_API_KEY",
  "OPENAI_API_KEY",
] as const;

/**
 * Explicitly allowed model credentials for the Muse child.
 * This is intentionally not arbitrary or task-controlled — only the credential(s)
 * genuinely required for Muse on this VPS.
 * On this VPS that is `MODEL_API_KEY`. Do not add Linear/BWS/GitHub secrets here.
 */
export const ALLOWED_MODEL_CREDENTIALS = ["MODEL_API_KEY"] as const;

const SAFE_EXACT_KEYS = new Set<string>([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHELL",
  "SSH_AUTH_SOCK",
  // Narrowly justified non-secret tool settings that are safe to inherit:
  // Terminal/color helpers do not carry secrets and affect tool output.
  "FORCE_COLOR",
  "COLORTERM",
  "NO_COLOR",
  "TERM_PROGRAM",
  // Node / npm operational (no tokens):
  "NODE_ENV",
  "CI",
  // XDG dirs for Muse/Git SSH config discovery (HOME-relative, no secrets):
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  // Git SSH helpers (no secrets):
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "GIT_TERMINAL_PROMPT",
  "SSH_AGENT_PID",
]);

function isSafeOperationalKey(key: string): boolean {
  if (SAFE_EXACT_KEYS.has(key)) return true;
  // Locale LC_* (e.g., LC_ALL, LC_CTYPE)
  if (key.startsWith("LC_")) return true;
  // Intentionally not allowing NPM_CONFIG_*, *TOKEN*, *SECRET*, LINEAR_*, BWS_* etc.
  return false;
}

export function getKnownServiceSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const vals: string[] = [];
  for (const k of KNOWN_SERVICE_SECRET_ENV_KEYS) {
    const v = env[k];
    if (typeof v === "string" && v.length >= 4) vals.push(v);
  }
  return vals;
}

/**
 * Build least-privilege environment for generic child processes (git, npm, validation).
 * Strips all known service secrets and only passes operational vars.
 */
export function buildSafeEnv(sourceEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(sourceEnv)) {
    if (v === undefined) continue;
    // Explicitly strip service secrets by prefix / exact name first.
    if (k.startsWith("LINEAR_")) continue;
    if (k.startsWith("BWS_")) continue;
    if (k === "GITHUB_TOKEN" || k === "GH_TOKEN" || k === "OPENAI_API_KEY" || k === "MODEL_API_KEY") continue;
    // Also block any BWS_* already covered, but keep explicit for clarity.
    if (!isSafeOperationalKey(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Build environment for the Muse worker.
 * Starts from safe env and adds only the explicitly allowed model credential(s).
 * Preserves HOME/PATH so Muse can use local auth/config.
 */
export function buildMuseEnv(sourceEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const safe = buildSafeEnv(sourceEnv);
  for (const k of ALLOWED_MODEL_CREDENTIALS) {
    const v = sourceEnv[k];
    if (typeof v === "string" && v.length > 0) {
      safe[k] = v;
    }
  }
  // Intentionally NOT adding LINEAR_*, BWS_*, GITHUB_TOKEN/GH_TOKEN, OPENAI_API_KEY
  // (except MODEL_API_KEY which is the single allowed credential).
  return safe;
}


/**
 * Redact exact known secret values from a message (literal, not pattern-based).
 * Used for opaque sentinels that have no ghp_/Bearer prefix.
 */
export function redactKnownSecrets(message: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!message) return message;
  let out = message;
  for (const secret of getKnownServiceSecretValues(env)) {
    if (!secret || secret.length < 4) continue;
    // literal split/join avoids regex escaping issues
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
