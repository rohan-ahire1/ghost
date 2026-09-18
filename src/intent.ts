/**
 * Intent gating for Ghost requests.
 *
 * Linear always delivers the FULL issue body as promptContext (often 10k+
 * chars describing an implementation ticket), even when the user just wrote a
 * one-line instruction. The user's ACTUAL triggering message arrives as
 * `initialPrompt` (extracted from the mentioning comment); these helpers fall
 * back to mining promptContext for it when it was not extracted.
 *
 * Short directives with no code-change request run in scratch: Muse answers
 * directly, no worktree, no commit, no push. Misrouting to scratch is safe by
 * design — the scratch prompt tells Muse to return blocked asking which
 * repository to use when edits genuinely need one. Greetings flow through
 * here like any other message: Muse answers conversationally in scratch.
 */

/** Verbs that indicate the request mutates repository code. */
const CODE_CHANGE_VERBS = [
  "implement",
  "fix",
  "build",
  "create",
  "add",
  "update",
  "refactor",
  "edit",
  "modify",
  "change",
  "migrate",
  "resolve",
  "address",
  "merge",
  "deploy",
  "publish",
  "write",
  "patch",
  "bump",
  "remove",
  "delete",
  "rename",
  "move",
  "split",
  "convert",
  "revert",
  "release",
  "scaffold",
];

/**
 * Extract the user's actual triggering message from a webhook payload and/or
 * promptContext. Returns undefined when nothing directive-like is found, in
 * which case callers must fall back to the previous behavior (repo when
 * resolved) rather than guessing.
 */
export function extractDirective(rawPayload: any, promptContext?: string): string | undefined {
  const candidates: unknown[] = [
    rawPayload?.agentSession?.comment?.body,
    rawPayload?.data?.agentSession?.comment?.body,
    rawPayload?.comment?.body,
    rawPayload?.data?.comment?.body,
    rawPayload?.agentActivity?.body,
    rawPayload?.data?.agentActivity?.body,
    rawPayload?.prompt,
    rawPayload?.data?.prompt,
    rawPayload?.text,
    rawPayload?.data?.text,
  ];
  for (const c of candidates) {
    const cleaned = cleanDirective(typeof c === "string" ? c : undefined);
    if (cleaned) return cleaned;
  }
  if (typeof promptContext === "string") {
    // Linear embeds the mentioning comment first:
    // <primary-directive-thread><comment ...>TEXT</comment>...
    const m = promptContext.match(/<primary-directive-thread[^>]*>[\s\S]*?<comment[^>]*>([\s\S]*?)<\/comment>/i);
    const cleaned = cleanDirective(m?.[1]);
    if (cleaned) return cleaned;
  }
  return undefined;
}

function cleanDirective(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = raw
    // Strip Linear mention tags like <user id="...">ghost</user>
    .replace(/<user[^>]*>[\s\S]*?<\/user>/gi, " ")
    // Strip any other XML-ish framing tags but keep inner text
    .replace(/<\/?(comment|primary-directive-thread|other-thread|issue|title|description|team|project|issue-relations|issue-ref|blocking|related)[^>]*>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 2) return undefined;
  // A bare "@ghost" mention with nothing else carries no directive
  if (/^@?ghost$/i.test(text)) return undefined;
  if (text.length > 2000) return text.slice(0, 2000);
  return text;
}

/**
 * True when the directive looks like Q&A/smalltalk with no code-change
 * request. Short messages without mutation verbs go to scratch; anything
 * ambiguous (long text, code verbs, or no extractable directive) keeps the
 * previous repo behavior.
 */
export function isQuickQuestion(directive: string | undefined): boolean {
  if (!directive) return false;
  const text = directive.trim();
  if (text.length === 0 || text.length > 280) return false;
  const lower = text.toLowerCase();
  for (const verb of CODE_CHANGE_VERBS) {
    // Bounded match so prose containing a verb stem as a substring of a
    // longer word does not count (e.g. "changelog" is not "change").
    const re = new RegExp(`(^|[^a-z])${verb}(s|d|ing|es)?([^a-z]|$)`);
    if (re.test(lower)) return false;
  }
  return true;
}
