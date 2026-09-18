export interface RepoConfig {
  id: string;
  aliases: string[];
  path: string;
  github: string; // owner/repo
  defaultBranch: string;
}

export interface ResolveResult {
  repo: RepoConfig | null;
  candidates: RepoConfig[];
  reason: string;
  elicitation?: string;
}

// Known repositories — exact aliases. Never accept arbitrary filesystem path from payload.
const DEFAULT_REPOS: RepoConfig[] = [
  {
    id: "scoutline",
    aliases: ["scoutline"],
    path: "/home/rohan/projects/scoutline",
    github: "rohan-ahire1/scoutline",
    defaultBranch: "main",
  },
  {
    id: "flaggo",
    aliases: ["flaggo"],
    path: "/home/rohan/projects/flaggo",
    github: "rohan-ahire1/flaggo",
    defaultBranch: "main",
  },
  {
    id: "portfolio",
    aliases: ["portfolio"],
    path: "/home/rohan/projects/portfolio",
    github: "rohan-ahire1/portfolio",
    defaultBranch: "main",
  },
  {
    id: "coachmate",
    aliases: ["coachmate", "chess-coach", "chess coach"],
    path: "/home/rohan/projects/coachmate",
    github: "rohan-ahire1/chess-coach",
    defaultBranch: "main",
  },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if alias appears as a bounded token in text.
 * Uses case-insensitive check with non-alphanumeric boundaries.
 * This prevents "flag" matching "flaggo" and similar issues.
 */
function matchesAlias(text: string, alias: string): boolean {
  if (!text || !alias) return false;
  const escaped = escapeRegExp(alias);
  // For aliases containing non-alphanumeric (hyphen, space), treat boundary as not alphanum
  // Equivalent to: alias must not be part of larger alphanumeric word
  const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
  return re.test(text);
}

function getRepos(): RepoConfig[] {
  // Support env overrides for path — documented in README
  const repos = DEFAULT_REPOS.map((r) => ({ ...r }));
  for (const repo of repos) {
    const envKey = `GHOST_REPO_${repo.id.toUpperCase().replace(/-/g, "_")}_PATH`;
    const override = process.env[envKey];
    if (override && override.trim()) {
      // Validate: must be absolute path, no shell injection via ;
      const trimmed = override.trim();
      if (trimmed.startsWith("/") && !trimmed.includes(";") && !trimmed.includes("`") && !trimmed.includes("$")) {
        repo.path = trimmed;
      }
    }
    // Also support generic JSON map GHOST_REPO_MAP e.g. {"scoutline":"/path"}
    const mapRaw = process.env.GHOST_REPO_MAP;
    if (mapRaw) {
      try {
        const map = JSON.parse(mapRaw);
        if (map && typeof map === "object" && typeof map[repo.id] === "string") {
          const p = (map[repo.id] as string).trim();
          if (p.startsWith("/") && !p.includes(";") && !p.includes("`")) repo.path = p;
        }
      } catch {
        // ignore invalid JSON
      }
    }
  }
  return repos;
}

export function getKnownRepos(): RepoConfig[] {
  return getRepos();
}

export function findRepoById(id: string): RepoConfig | null {
  const repos = getRepos();
  const lower = id.toLowerCase();
  return repos.find((r) => r.id.toLowerCase() === lower) || null;
}

/**
 * Linear project → repo mapping from GHOST_PROJECT_MAP, e.g.
 * {"Scoutline app": "scoutline", "abc-123-def": "flaggo"}.
 * Keys are matched case-insensitively against the Linear project name or id.
 */
function getProjectMap(): Record<string, string> {
  const raw = process.env.GHOST_PROJECT_MAP;
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === "string" && typeof v === "string" && k.trim() && v.trim()) {
        out[k.trim().toLowerCase()] = v.trim().toLowerCase();
      }
    }
    return out;
  } catch {
    return {};
  }
}

function extractLabelNames(rawPayload: any): string[] {
  const names: string[] = [];
  const labels =
    rawPayload?.agentSession?.issue?.labels ||
    rawPayload?.data?.issue?.labels ||
    rawPayload?.issue?.labels ||
    [];
  if (Array.isArray(labels)) {
    for (const l of labels) {
      if (typeof l === "string" && l.trim()) names.push(l.trim());
      else if (l && typeof l.name === "string" && l.name.trim()) names.push(l.name.trim());
    }
  }
  return names;
}

function extractProjectNames(rawPayload: any, promptContext?: string): string[] {
  const names: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string" && v.trim()) names.push(v.trim().slice(0, 200));
  };
  const candidates = [
    rawPayload?.agentSession?.issue?.project,
    rawPayload?.data?.issue?.project,
    rawPayload?.issue?.project,
    rawPayload?.agentSession?.project,
    rawPayload?.data?.project,
    rawPayload?.project,
  ];
  for (const p of candidates) {
    if (typeof p === "string") push(p);
    else if (p && typeof p === "object") {
      push((p as { name?: unknown }).name);
      push((p as { id?: unknown }).id);
    }
  }
  if (typeof promptContext === "string") {
    const body = promptContext.match(/<project[^>]*>([\s\S]*?)<\/project>/i);
    if (body) push(body[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
    const attr = promptContext.match(/<project[^>]*\bname="([^"]+)"/i);
    if (attr) push(attr[1]);
  }
  return names;
}

export function resolveRepository(params: {
  issueIdentifier?: string;
  issueTitle?: string;
  promptContext?: string;
  rawPayload?: any;
}): ResolveResult {
  const { issueIdentifier, issueTitle, promptContext, rawPayload } = params;
  const repos = getRepos();

  // Priority 1: exact label match. A Linear label naming the repo (e.g.
  // "scoutline") is deliberate routing and beats substring guessing.
  const labelNames = extractLabelNames(rawPayload);
  if (labelNames.length > 0) {
    const labelMatched: RepoConfig[] = [];
    for (const repo of repos) {
      const names = [repo.id, ...repo.aliases].map((a) => a.toLowerCase());
      if (labelNames.some((l) => names.includes(l.toLowerCase()))) labelMatched.push(repo);
    }
    const labelUnique = Array.from(new Map(labelMatched.map((r) => [r.id, r])).values());
    if (labelUnique.length === 1) {
      return { repo: labelUnique[0], candidates: labelUnique, reason: "exact label match" };
    }
    if (labelUnique.length > 1) {
      const names = labelUnique.map((r) => r.id).join(", ");
      return {
        repo: null,
        candidates: labelUnique,
        reason: `multiple repos matched: ${names}`,
        elicitation: `Ghost found multiple matching repositories (${names}). Please clarify which single repository to use by keeping only one repo label.`,
      };
    }
  }

  // Priority 2: Linear project → repo map (GHOST_PROJECT_MAP).
  const projectMap = getProjectMap();
  if (Object.keys(projectMap).length > 0) {
    const projectNames = extractProjectNames(rawPayload, promptContext);
    const projectMatched: RepoConfig[] = [];
    for (const name of projectNames) {
      const mapped = projectMap[name.toLowerCase()];
      if (mapped) {
        const repo = repos.find(
          (r) => r.id.toLowerCase() === mapped || r.aliases.some((a) => a.toLowerCase() === mapped),
        );
        if (repo) projectMatched.push(repo);
      }
    }
    const projectUnique = Array.from(new Map(projectMatched.map((r) => [r.id, r])).values());
    if (projectUnique.length === 1) {
      return { repo: projectUnique[0], candidates: projectUnique, reason: "project map match" };
    }
    if (projectUnique.length > 1) {
      const names = projectUnique.map((r) => r.id).join(", ");
      return {
        repo: null,
        candidates: projectUnique,
        reason: `multiple repos matched: ${names}`,
        elicitation: `Ghost found multiple matching repositories (${names}). Please clarify which single repository to use.`,
      };
    }
  }

  // Priority 3: alias substring matching over safe text sources.
  // Collect safe text sources — never use arbitrary filesystem path from payload
  const parts: string[] = [];
  if (issueIdentifier) parts.push(issueIdentifier);
  if (issueTitle) parts.push(issueTitle);
  if (promptContext) parts.push(promptContext);

  // Safe payload metadata: only inspect known string fields, not file paths
  if (rawPayload) {
    const safeFields = [
      rawPayload?.agentSession?.issue?.title,
      rawPayload?.data?.issue?.title,
      rawPayload?.issue?.title,
      rawPayload?.agentSession?.issue?.identifier,
      rawPayload?.data?.issue?.identifier,
      // Branch or label hints if present as plain strings (not paths)
      rawPayload?.issue?.branchName,
    ];
    for (const f of safeFields) {
      if (typeof f === "string") parts.push(f);
    }
    for (const name of labelNames) parts.push(name);
  }

  const combined = parts.join(" \n ");

  // Never accept arbitrary filesystem path from payload — reject if combined looks like a path injection attempt
  // We only use alias matching, not path extraction
  const matched: RepoConfig[] = [];

  for (const repo of repos) {
    for (const alias of repo.aliases) {
      if (matchesAlias(combined, alias)) {
        matched.push(repo);
        break;
      }
    }
  }

  // Deduplicate (in case alias overlap)
  const unique = Array.from(new Map(matched.map((r) => [r.id, r])).values());

  if (unique.length === 1) {
    return { repo: unique[0], candidates: unique, reason: "single match" };
  }

  if (unique.length === 0) {
    // Permit well-documented default override
    const defaultId = process.env.GHOST_DEFAULT_REPO?.trim().toLowerCase();
    if (defaultId) {
      const def = repos.find((r) => r.id.toLowerCase() === defaultId || r.aliases.some((a) => a.toLowerCase() === defaultId));
      if (def) {
        return { repo: def, candidates: [], reason: "fallback to GHOST_DEFAULT_REPO" };
      }
    }
    const elicitation = `Ghost could not determine the target repository. Please specify one of: ${repos.map((r) => r.id).join(", ")}. Include the repo name (e.g., "scoutline", "flaggo", "portfolio", "coachmate") in the issue title.`;
    return { repo: null, candidates: [], reason: "no repo matched", elicitation };
  }

  // Multiple matches
  const names = unique.map((r) => r.id).join(", ");
  const elicitation = `Ghost found multiple matching repositories (${names}). Please clarify which single repository to use by including only one repo name in the issue title.`;
  return { repo: null, candidates: unique, reason: `multiple repos matched: ${names}`, elicitation };
}

/**
 * Safe branch name from issue identifier and session ID.
 *
 * Linear can open several distinct sessions for one issue (for example, two
 * separate @mentions). A branch based only on the issue id collides after the
 * first worktree is removed because Git correctly retains its local branch.
 * Include a stable, sanitized session suffix so every independent session has
 * an isolated branch while retries of the same session retain the same name.
 */
export function buildBranchName(issueIdentifier?: string, sessionId?: string): string {
  let base: string | undefined = issueIdentifier?.trim().toLowerCase();
  if (base) {
    // Sanitize: keep a-z0-9, replace other runs with hyphen
    base = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
    // Limit length to 50, ensure not empty
    if (base.length > 50) base = base.slice(0, 50).replace(/-+$/, "");
    if (base.length === 0) base = undefined;
  }
  const sessionSuffix = sessionId
    ? sessionId.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").replace(/-+$/, "").slice(0, 32)
    : "";
  if (!base) base = sessionSuffix ? `session-${sessionSuffix}` : "session-unknown";
  else if (sessionSuffix) base = `${base}-${sessionSuffix}`;
  return `ghost/${base}`;
}

export function getCompareUrl(ownerRepo: string, branch: string): string {
  return `https://github.com/${ownerRepo}/compare/main...${encodeURIComponent(branch)}?expand=1`;
}
