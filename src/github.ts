import { sanitizeError, redactWithValue } from "./commandRunner.js";

export interface CreatePrOptions {
  token: string;
  ownerRepo: string; // "rohan-ahire1/scoutline"
  branch: string;
  title: string;
  body: string;
  base?: string;
}

export interface PrResult {
  prUrl?: string;
  compareUrl: string;
  created: boolean;
}

function getCompareUrl(ownerRepo: string, branch: string): string {
  return `https://github.com/${ownerRepo}/compare/main...${encodeURIComponent(branch)}?expand=1`;
}

export async function createPullRequest(opts: CreatePrOptions, fetchFn?: typeof fetch): Promise<PrResult> {
  const fetcher = fetchFn || fetch;
  const [owner, repo] = opts.ownerRepo.split("/");
  const compareUrl = getCompareUrl(opts.ownerRepo, opts.branch);
  const base = opts.base || "main";

  if (!owner || !repo) {
    return { compareUrl, created: false };
  }

  // First, check for existing PR via list API: GET /repos/{owner}/{repo}/pulls?head=owner:branch&state=open
  try {
    const listUrl = `https://api.github.com/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${opts.branch}`)}&state=open`;
    const listRes = await fetcher(listUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ghost-pipeline",
      },
    });
    if (listRes.ok) {
      const listText = await listRes.text();
      try {
        const arr = JSON.parse(listText);
        if (Array.isArray(arr) && arr.length > 0) {
          const first = arr[0];
          if (first.html_url) {
            // Already exists — treat as success without logging token
            return { prUrl: first.html_url as string, compareUrl, created: false };
          }
          if (first.url) {
            return { prUrl: first.html_url || first.url, compareUrl, created: false };
          }
        }
      } catch {}
    } else {
      // Non-ok list, continue to create attempt
      console.warn(JSON.stringify({ msg: "github list PRs failed", status: listRes.status }));
    }
  } catch (err) {
    const safe = redactWithValue((err as Error).message, [opts.token], 300);
    console.warn(JSON.stringify({ msg: "github list PRs error", error: safe }));
    // Continue to create
  }

  // Attempt to create PR — redact model-controlled title/body before external payload
  try {
    const safeTitle = sanitizeError(opts.title.slice(0, 200), 200);
    const safeBody = sanitizeError(opts.body.slice(0, 8000), 8000);
    const createUrl = `https://api.github.com/repos/${owner}/${repo}/pulls`;
    const body = JSON.stringify({
      title: safeTitle,
      body: safeBody,
      head: opts.branch,
      base,
    });

    const createRes = await fetcher(createUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "ghost-pipeline",
      },
      body,
    });

    const text = await createRes.text();

    if (createRes.ok) {
      try {
        const json = JSON.parse(text);
        if (json.html_url) {
          return { prUrl: json.html_url as string, compareUrl, created: true };
        }
        if (json.url) {
          return { prUrl: json.html_url || json.url, compareUrl, created: true };
        }
      } catch {}
      // Fallback: treat as success even if parse fails but status ok
      return { compareUrl, created: true };
    }

    // If 422, might be already exists (race) — treat as success and try to find URL from error
    if (createRes.status === 422) {
      // Search error text for existing PR URL? Instead, re-list
      try {
        const listUrl2 = `https://api.github.com/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${opts.branch}`)}&state=open`;
        const listRes2 = await fetcher(listUrl2, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${opts.token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "ghost-pipeline",
          },
        });
        if (listRes2.ok) {
          const arr = JSON.parse(await listRes2.text());
          if (Array.isArray(arr) && arr.length > 0 && arr[0].html_url) {
            return { prUrl: arr[0].html_url, compareUrl, created: false };
          }
        }
      } catch {}
      console.warn(JSON.stringify({ msg: "github PR already exists (422)", branch: opts.branch }));
      return { compareUrl, created: false };
    }

    const redactedBody = redactWithValue(text.slice(0, 500), [opts.token], 500);
    console.error(JSON.stringify({ msg: "github create PR failed", status: createRes.status, body: redactedBody }));
    // Return compare URL as fallback, do not claim PR created
    return { compareUrl, created: false };
  } catch (err) {
    const safe = redactWithValue((err as Error).message, [opts.token], 300);
    console.error(JSON.stringify({ msg: "github create PR error", error: safe }));
    return { compareUrl, created: false };
  }
}

export function resolvePrOrCompareUrl(ownerRepo: string, branch: string, prResult?: PrResult): string {
  if (prResult?.prUrl) return prResult.prUrl;
  if (prResult?.compareUrl) return prResult.compareUrl;
  return getCompareUrl(ownerRepo, branch);
}

export function getGithubToken(): string | null {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}
