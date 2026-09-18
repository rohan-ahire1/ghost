import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveRepository, buildBranchName, getCompareUrl, getKnownRepos } from "../dist/repoResolver.js";

describe("repoResolver", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    // restore env
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(origEnv)) process.env[k] = v;
  });

  it("resolves single alias from issueTitle", () => {
    const r = resolveRepository({ issueTitle: "Fix bug in scoutline search" });
    assert.equal(r.repo?.id, "scoutline");
    assert.equal(r.reason, "single match");
  });

  it("resolves case-insensitively", () => {
    const r = resolveRepository({ promptContext: "FLAGGO need feature" });
    assert.equal(r.repo?.id, "flaggo");
  });

  it("no repo matched returns elicitation", () => {
    const r = resolveRepository({ issueTitle: "Fix unrelated bug", promptContext: "do something" });
    assert.equal(r.repo, null);
    assert.equal(r.reason, "no repo matched");
    assert.ok(r.elicitation?.includes("could not determine"));
  });

  it("multiple repos matched returns elicitation", () => {
    const r = resolveRepository({ issueTitle: "scoutline and flaggo integration" });
    assert.equal(r.repo, null);
    assert.ok(r.reason.startsWith("multiple repos matched"));
    assert.ok(r.elicitation?.includes("multiple matching"));
    assert.equal(r.candidates.length, 2);
  });

  it("exact boundary prevents substring false positives", () => {
    // "flag" should not match "flaggo"
    const r = resolveRepository({ issueTitle: "flag work" });
    assert.equal(r.repo, null);
    assert.equal(r.reason, "no repo matched");
  });

  it("never accepts arbitrary filesystem path from payload", () => {
    const payload = {
      agentSession: { issue: { title: "test" } },
      arbitraryPath: "/home/rohan/scoutline",
      promptContext: '/home/rohan/scoutline',
    };
    // Even if prompt contains path, resolver should not treat path as repo unless alias present
    // Our resolver only uses issueTitle, identifier, promptContext. Path string contains "scoutline" as substring -> it would match because alias in path.
    // But we must ensure it doesn't blindly use path field — it only checks alias presence, not path field directly
    // So path containing scoutline will still match via promptContext, but arbitraryPath field should be ignored
    const r1 = resolveRepository({ issueTitle: "random", rawPayload: { arbitraryPath: "/home/rohan/scoutline" } });
    assert.equal(r1.repo, null, "arbitraryPath field must be ignored");
    const r2 = resolveRepository({ promptContext: "/home/rohan/scoutline do work" });
    // This contains alias scoutline, so it will match — that's alias matching, not path acceptance
    assert.equal(r2.repo?.id, "scoutline");
  });

  it("coachmate chess-coach alias works", () => {
    const r = resolveRepository({ issueTitle: "fix chess-coach board" });
    assert.equal(r.repo?.id, "coachmate");
  });

  it("coachmate alias with space", () => {
    const r = resolveRepository({ issueTitle: "chess coach feature" });
    assert.equal(r.repo?.id, "coachmate");
  });

  it("GHOST_DEFAULT_REPO fallback when no match", () => {
    process.env.GHOST_DEFAULT_REPO = "portfolio";
    const r = resolveRepository({ issueTitle: "unknown task without repo" });
    assert.equal(r.repo?.id, "portfolio");
    assert.equal(r.reason, "fallback to GHOST_DEFAULT_REPO");
  });

  it("GHOST_DEFAULT_REPO not used when single match exists", () => {
    process.env.GHOST_DEFAULT_REPO = "portfolio";
    const r = resolveRepository({ issueTitle: "scoutline bug" });
    assert.equal(r.repo?.id, "scoutline");
  });

  it("GHOST_DEFAULT_REPO invalid does not override elicitation", () => {
    process.env.GHOST_DEFAULT_REPO = "nonexistent";
    const r = resolveRepository({ issueTitle: "unknown" });
    assert.equal(r.repo, null);
  });

  it("branch naming includes a session suffix to isolate distinct sessions", () => {
    assert.equal(buildBranchName("SCOUT-123 Fix Bug!", "sess-abc"), "ghost/scout-123-fix-bug-sess-abc");
    assert.notEqual(
      buildBranchName("ROH-15", "session-one"),
      buildBranchName("ROH-15", "session-two"),
      "separate sessions for one issue must never share a branch",
    );
  });

  it("branch fallback uses sessionId", () => {
    const b = buildBranchName(undefined, "sess-xyz-123_abc");
    assert.equal(b, "ghost/session-sess-xyz-123-abc");
  });

  it("branch sanitization handles empty identifier", () => {
    const b = buildBranchName("!!!", "sess-1");
    assert.ok(b.startsWith("ghost/"));
    assert.ok(b.length > "ghost/".length);
  });

  it("branch lowercases", () => {
    assert.equal(buildBranchName("FLAG-999", "S"), "ghost/flag-999-s");
  });

  it("compare URL encoding", () => {
    const url = getCompareUrl("rohan-ahire1/scoutline", "ghost/scout-123");
    assert.equal(url, "https://github.com/rohan-ahire1/scoutline/compare/main...ghost%2Fscout-123?expand=1");
    const url2 = getCompareUrl("rohan-ahire1/chess-coach", "ghost/feat");
    assert.ok(url2.includes("chess-coach"));
  });

  it("getKnownRepos returns 4 repos", () => {
    const repos = getKnownRepos();
    assert.equal(repos.length, 4);
    assert.ok(repos.some((r) => r.id === "scoutline"));
  });

  it("exact label match routes without repo name in title", () => {
    const r = resolveRepository({
      issueTitle: "Preserve unknown metrics",
      rawPayload: { agentSession: { issue: { labels: [{ name: "scoutline" }] } } },
    });
    assert.equal(r.repo?.id, "scoutline");
    assert.equal(r.reason, "exact label match");
  });

  it("exact label match beats conflicting title text", () => {
    const r = resolveRepository({
      issueTitle: "flaggo integration work",
      rawPayload: { issue: { labels: ["scoutline"] } },
    });
    assert.equal(r.repo?.id, "scoutline");
    assert.equal(r.reason, "exact label match");
  });

  it("conflicting repo labels ask for clarification", () => {
    const r = resolveRepository({
      issueTitle: "integration work",
      rawPayload: { issue: { labels: [{ name: "scoutline" }, { name: "flaggo" }] } },
    });
    assert.equal(r.repo, null);
    assert.ok(r.reason.startsWith("multiple repos matched"));
    assert.equal(r.candidates.length, 2);
  });

  it("project map routes by Linear project name", () => {
    process.env.GHOST_PROJECT_MAP = JSON.stringify({ "Scoutline app": "scoutline" });
    const r = resolveRepository({
      issueTitle: "Preserve unknown metrics",
      rawPayload: { agentSession: { issue: { project: { name: "Scoutline app" } } } },
    });
    assert.equal(r.repo?.id, "scoutline");
    assert.equal(r.reason, "project map match");
  });

  it("project map routes by Linear project id and promptContext tag", () => {
    process.env.GHOST_PROJECT_MAP = JSON.stringify({ "proj-123": "flaggo" });
    const r = resolveRepository({
      issueTitle: "Some feature",
      promptContext: '<issue><project name="proj-123">Flaggo board</project></issue>',
    });
    assert.equal(r.repo?.id, "flaggo");
    assert.equal(r.reason, "project map match");
  });

  it("invalid project map JSON is ignored safely", () => {
    process.env.GHOST_PROJECT_MAP = "{not json";
    const r = resolveRepository({ issueTitle: "scoutline bug" });
    assert.equal(r.repo?.id, "scoutline");
    assert.equal(r.reason, "single match");
  });

  it("label match beats project map", () => {
    process.env.GHOST_PROJECT_MAP = JSON.stringify({ "Scoutline app": "scoutline" });
    const r = resolveRepository({
      issueTitle: "Some feature",
      rawPayload: {
        agentSession: { issue: { project: { name: "Scoutline app" }, labels: ["portfolio"] } },
      },
    });
    assert.equal(r.repo?.id, "portfolio");
    assert.equal(r.reason, "exact label match");
  });
});
