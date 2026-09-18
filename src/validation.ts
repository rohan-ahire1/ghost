// Validation via package.json scripts — deterministic selection, no task-provided commands

export const RECOGNIZED_CHECKS = ["test", "typecheck", "lint", "build"] as const;

export type RecognizedCheck = (typeof RECOGNIZED_CHECKS)[number];

export interface PackageJson {
  scripts?: Record<string, string>;
}

export interface SelectedCheck {
  name: RecognizedCheck;
  command: string;
  args: string[];
}

/**
 * Deterministically select existing scripts from package.json.
 * Order is fixed: test, typecheck, lint, build.
 * Only scripts that exist in package.json are selected.
 * Missing test script is not failure but is recorded.
 */
export function selectValidationChecks(pkg: PackageJson): SelectedCheck[] {
  if (!pkg || !pkg.scripts) return [];
  const selected: SelectedCheck[] = [];
  for (const name of RECOGNIZED_CHECKS) {
    if (pkg.scripts[name]) {
      selected.push({ name, command: "npm", args: ["run", name] });
    }
  }
  return selected;
}

export function getValidationSummary(pkg: PackageJson, selected: SelectedCheck[]): string {
  const available = pkg.scripts ? Object.keys(pkg.scripts).filter((k) => (RECOGNIZED_CHECKS as readonly string[]).includes(k)) : [];
  const selectedNames = selected.map((s) => s.name);
  const skipped = available.filter((n) => !selectedNames.includes(n as RecognizedCheck));
  // Should not happen because we select all available, but for reporting
  return `available: [${available.join(", ")}]; selected: [${selectedNames.join(", ")}]; skipped: [${skipped.join(", ")}]`;
}

// Secret/path rejection

const SECRET_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|\/)\.env(\.|$)/, reason: ".env file" },
  { re: /(^|\/)\.env\./, reason: ".env file" },
  { re: /credentials/i, reason: "credentials" },
  { re: /\.pem$/i, reason: "private key .pem" },
  { re: /\.key$/i, reason: "private key .key" },
  { re: /\.p12$/i, reason: "private key .p12" },
  { re: /\.pfx$/i, reason: "private key .pfx" },
  { re: /(^|\/)id_rsa/, reason: "private key id_rsa" },
  { re: /tokens\.json$/i, reason: "token store tokens.json" },
  { re: /\.config\/ghost/i, reason: "Ghost data" },
  { re: /(^|\/)ghost\/.*tokens/i, reason: "Ghost data" },
  { re: /secrets?/i, reason: "secret file" },
];

export function isSecretPath(filePath: string): { blocked: boolean; reason?: string } {
  if (!filePath) return { blocked: false };
  const normalized = filePath.replace(/\\/g, "/");
  for (const { re, reason } of SECRET_PATTERNS) {
    if (re.test(normalized)) {
      // Allow .env.example as non-secret? But spec says reject .env — we treat .env.example as safe exception
      if (normalized.endsWith(".env.example")) continue;
      return { blocked: true, reason };
    }
  }
  // Ghost data dir check — if GHOST_DATA_DIR is set and path contains it
  const dataDir = process.env.GHOST_DATA_DIR || "/home/rohan/.config/ghost";
  if (normalized.includes(dataDir)) {
    return { blocked: true, reason: "Ghost data directory" };
  }
  return { blocked: false };
}

export function filterSecretFiles(files: string[]): { blocked: string[]; safe: string[] } {
  const blocked: string[] = [];
  const safe: string[] = [];
  for (const f of files) {
    const r = isSecretPath(f);
    if (r.blocked) blocked.push(f);
    else safe.push(f);
  }
  return { blocked, safe };
}
