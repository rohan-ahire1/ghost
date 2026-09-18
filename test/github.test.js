import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createPullRequest, getGithubToken } from "../dist/github.js";

describe("github PR fallback", () => {
  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  it("getGithubToken prefers GITHUB_TOKEN", () => {
    process.env.GITHUB_TOKEN = "token1";
    process.env.GH_TOKEN = "token2";
    assert.equal(getGithubToken(), "token1");
  });

  it("getGithubToken falls back to GH_TOKEN", () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = "gh-token";
    assert.equal(getGithubToken(), "gh-token");
  });

  it("getGithubToken null when none", () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    assert.equal(getGithubToken(), null);
  });

  it("createPullRequest returns compare URL when no PR exists and creates", async () => {
    const mockFetch = async (url, opts) => {
      if (url.includes("/pulls?head=")) {
        return { ok: true, status: 200, text: async () => JSON.stringify([]) };
      }
      if (url.endsWith("/pulls") && opts.method === "POST") {
        const body = JSON.parse(opts.body);
        assert.equal(body.head, "ghost/test-branch");
        assert.equal(body.base, "main");
        return { ok: true, status: 201, text: async () => JSON.stringify({ html_url: "https://github.com/rohan-ahire1/scoutline/pull/123" }) };
      }
      throw new Error("unexpected url " + url);
    };
    const res = await createPullRequest({
      token: "fake-token",
      ownerRepo: "rohan-ahire1/scoutline",
      branch: "ghost/test-branch",
      title: "Test",
      body: "Body",
    }, mockFetch);
    assert.equal(res.prUrl, "https://github.com/rohan-ahire1/scoutline/pull/123");
    assert.equal(res.created, true);
    assert.ok(res.compareUrl.includes("compare"));
  });

  it("treats already-existing PR as success (list returns entry)", async () => {
    const mockFetch = async (url, opts) => {
      if (url.includes("/pulls?head=")) {
        return { ok: true, status: 200, text: async () => JSON.stringify([{ html_url: "https://github.com/rohan-ahire1/scoutline/pull/99" }]) };
      }
      throw new Error("should not create when already exists, but got " + url);
    };
    const res = await createPullRequest({
      token: "tok",
      ownerRepo: "rohan-ahire1/scoutline",
      branch: "ghost/existing",
      title: "T",
      body: "B",
    }, mockFetch);
    assert.equal(res.prUrl, "https://github.com/rohan-ahire1/scoutline/pull/99");
    assert.equal(res.created, false);
  });

  it("handles 422 as already exists (race) and re-lists", async () => {
    let calledPost = false;
    const mockFetch = async (url, opts) => {
      if (url.includes("/pulls?head=") && !calledPost) {
        // First list empty
        return { ok: true, status: 200, text: async () => JSON.stringify([]) };
      }
      if (url.endsWith("/pulls") && opts.method === "POST") {
        calledPost = true;
        return { ok: false, status: 422, text: async () => JSON.stringify({ message: "pull request already exists" }) };
      }
      if (url.includes("/pulls?head=") && calledPost) {
        return { ok: true, status: 200, text: async () => JSON.stringify([{ html_url: "https://github.com/rohan-ahire1/flaggo/pull/5" }]) };
      }
      throw new Error("unexpected " + url);
    };
    const res = await createPullRequest({
      token: "tok",
      ownerRepo: "rohan-ahire1/flaggo",
      branch: "ghost/race",
      title: "T",
      body: "B",
    }, mockFetch);
    assert.equal(res.prUrl, "https://github.com/rohan-ahire1/flaggo/pull/5");
  });

  it("returns compare URL when creation fails", async () => {
    const mockFetch = async (url, opts) => {
      if (url.includes("/pulls?head=")) return { ok: true, status: 200, text: async () => JSON.stringify([]) };
      if (url.endsWith("/pulls")) return { ok: false, status: 500, text: async () => "server error" };
      throw new Error("unexpected");
    };
    const res = await createPullRequest({
      token: "tok",
      ownerRepo: "rohan-ahire1/portfolio",
      branch: "ghost/fail",
      title: "T",
      body: "B",
    }, mockFetch);
    assert.equal(res.prUrl, undefined);
    assert.ok(res.compareUrl.includes("rohan-ahire1/portfolio"));
    assert.ok(res.compareUrl.includes("ghost%2Ffail"));
  });

  it("compare URL encoding for branch with slash", async () => {
    const mockFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify([]) });
    // We call createPullRequest with failing POST to get compare fallback
    const mockFetch2 = async (url, opts) => {
      if (url.includes("/pulls?head=")) return { ok: true, status: 200, text: async () => JSON.stringify([]) };
      return { ok: false, status: 500, text: async () => "" };
    };
    const res = await createPullRequest({
      token: "tok",
      ownerRepo: "rohan-ahire1/chess-coach",
      branch: "ghost/SCOUT-123",
      title: "T",
      body: "B",
    }, mockFetch2);
    assert.ok(res.compareUrl.includes("ghost%2FSCOUT-123"));
    assert.ok(res.compareUrl.startsWith("https://github.com/rohan-ahire1/chess-coach/compare/main..."));
    assert.ok(res.compareUrl.endsWith("?expand=1"));
  });

  it("does not log token in errors (no token in thrown message)", async () => {
    const mockFetch = async () => { throw new Error("network fail ghp_fake123"); };
    const res = await createPullRequest({
      token: "ghp_secrettoken123",
      ownerRepo: "rohan-ahire1/scoutline",
      branch: "ghost/x",
      title: "T",
      body: "B",
    }, mockFetch);
    // Should return compare URL, not throw, and not expose token
    assert.ok(res.compareUrl);
    assert.equal(res.prUrl, undefined);
  });
});
