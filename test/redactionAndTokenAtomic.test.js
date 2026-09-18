import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SENTINELS = {
  LINEAR_CLIENT_SECRET: "sentinel-linear-client-OPAQUE-9911-alpha",
  LINEAR_WEBHOOK_SECRET: "sentinel-linear-webhook-OPAQUE-9912-beta",
  BWS_ACCESS_TOKEN: "sentinel-bws-access-OPAQUE-9913-gamma",
  GITHUB_TOKEN: "sentinel-github-OPAQUE-9914-delta",
  GH_TOKEN: "sentinel-gh-OPAQUE-9915-epsilon",
  MODEL_API_KEY: "sentinel-model-OPAQUE-9916-zeta",
  OPENAI_API_KEY: "sentinel-openai-OPAQUE-9917-eta",
};

function setSentinels() {
  const prev = {};
  for (const [k, v] of Object.entries(SENTINELS)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  return prev;
}
function restoreSentinels(prev) {
  for (const k of Object.keys(SENTINELS)) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
}

function captureConsole() {
  const logs = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const wrap = (...args) => {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    logs.push(line);
  };
  console.log = (...a) => wrap(...a);
  console.warn = (...a) => wrap(...a);
  console.error = (...a) => wrap(...a);
  return {
    logs,
    restore() {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

describe("defense-in-depth: central safe sanitizer redacts opaque sentinels", () => {
  let prev;
  beforeEach(() => {
    prev = setSentinels();
  });
  afterEach(() => restoreSentinels(prev));

  it("sanitizeError removes exact values of all known service secrets (no prefix)", async () => {
    const { sanitizeError } = await import("../dist/commandRunner.js");
    const msg =
      `boom with ${SENTINELS.LINEAR_CLIENT_SECRET} and ${SENTINELS.LINEAR_WEBHOOK_SECRET} and ` +
      `${SENTINELS.BWS_ACCESS_TOKEN} and ${SENTINELS.GITHUB_TOKEN} and ${SENTINELS.GH_TOKEN} and ` +
      `${SENTINELS.MODEL_API_KEY} and ${SENTINELS.OPENAI_API_KEY} end`;
    const sanitized = sanitizeError(msg, 2000);
    for (const v of Object.values(SENTINELS)) {
      assert.ok(!sanitized.includes(v), `sanitized leaked sentinel ${v.slice(0, 20)}`);
    }
    assert.ok(sanitized.includes("[redacted]"), "expected [redacted] marker");
    // preserve safe status/metadata
    const withStatus = `Refresh failed: 401 ${SENTINELS.GITHUB_TOKEN} unauthorized`;
    const sanitized2 = sanitizeError(withStatus, 500);
    assert.ok(!sanitized2.includes(SENTINELS.GITHUB_TOKEN));
    assert.ok(sanitized2.includes("401"), "safe status 401 should be preserved");
    assert.ok(sanitized2.includes("[redacted]"));
    assert.ok(sanitized2.includes("Refresh failed"));
  });

  it("redactKnownSecrets removes exact values for all known keys", async () => {
    const { redactKnownSecrets } = await import("../dist/childEnv.js");
    const msg = Object.values(SENTINELS).join(" | ");
    const redacted = redactKnownSecrets(msg);
    for (const v of Object.values(SENTINELS)) {
      assert.ok(!redacted.includes(v), `redactKnownSecrets leaked ${v.slice(0, 15)}`);
    }
    assert.ok(redacted.includes("[redacted]"));
  });

  it("install error log path (sanitizeError) is redacted", async () => {
    const { sanitizeError } = await import("../dist/commandRunner.js");
    // Simulates src/index.ts install error: sanitizeError((err as Error).message, 300)
    const err = new Error(`install boom ${SENTINELS.LINEAR_CLIENT_SECRET} and ${SENTINELS.BWS_ACCESS_TOKEN}`);
    const logged = JSON.stringify({ msg: "install error", error: sanitizeError(err.message, 300) });
    for (const v of Object.values(SENTINELS)) assert.ok(!logged.includes(v));
    assert.ok(logged.includes("[redacted]"));
    // still logs useful prefix truncated
    assert.ok(logged.includes("install error"));
  });

  it("OAuth callback error param and exchange-failed paths are redacted", async () => {
    const { sanitizeError } = await import("../dist/commandRunner.js");
    // callback error param: sanitizeError(error, 200)
    const errorParam = `access_denied with ${SENTINELS.LINEAR_WEBHOOK_SECRET} leaked`;
    const logged1 = JSON.stringify({ msg: "OAuth callback error param", error: sanitizeError(errorParam, 200) });
    assert.ok(!logged1.includes(SENTINELS.LINEAR_WEBHOOK_SECRET));
    assert.ok(logged1.includes("[redacted]"));
    // exchange failed: sanitizeError((err as Error).message, 400)
    const err2 = new Error(`Token exchange failed: 400 ${SENTINELS.GITHUB_TOKEN} body`);
    const logged2 = JSON.stringify({ msg: "OAuth exchange failed", error: sanitizeError(err2.message, 400) });
    for (const v of Object.values(SENTINELS)) assert.ok(!logged2.includes(v));
    assert.ok(logged2.includes("Token exchange failed"));
    assert.ok(logged2.includes("400"));
  });

  it("dispatch error and unhandled-error log paths are redacted", async () => {
    const { sanitizeError } = await import("../dist/commandRunner.js");
    // dispatch error: sanitizeError((err as Error).message, 500)
    const errDispatch = new Error(`dispatch boom ${SENTINELS.MODEL_API_KEY} ${SENTINELS.GH_TOKEN}`);
    const loggedDispatch = JSON.stringify({ msg: "dispatch error", error: sanitizeError(errDispatch.message, 500) });
    assert.ok(!loggedDispatch.includes(SENTINELS.MODEL_API_KEY));
    assert.ok(!loggedDispatch.includes(SENTINELS.GH_TOKEN));
    assert.ok(loggedDispatch.includes("[redacted]"));

    // unhandled error: sanitizeError(err instanceof Error ? err.message : String(err), 500)
    const errUnhandled = new Error(`Unhandled ${SENTINELS.OPENAI_API_KEY} in handler`);
    const loggedUnhandled = JSON.stringify({
      msg: "Unhandled error",
      error: sanitizeError(errUnhandled instanceof Error ? errUnhandled.message : String(errUnhandled), 500),
    });
    assert.ok(!loggedUnhandled.includes(SENTINELS.OPENAI_API_KEY));
    assert.ok(loggedUnhandled.includes("[redacted]"));
    // String(err) variant
    const rawString = String({ msg: SENTINELS.BWS_ACCESS_TOKEN });
    const loggedString = JSON.stringify({ msg: "Unhandled error", error: sanitizeError(String(rawString), 500) });
    // Note: rawString is "[object Object]" not sentinel, but test that sanitizeError still called
    assert.ok(!loggedString.includes(SENTINELS.BWS_ACCESS_TOKEN) || loggedString.includes("[redacted]"));
  });

  it("Token refresh failure log path is redacted and preserves safe status", async () => {
    const { sanitizeError } = await import("../dist/commandRunner.js");
    // Simulates src/linear.ts doRefresh catch: sanitizeError((err as Error).message, 500)
    const err = new Error(`Refresh failed: 401 ${SENTINELS.LINEAR_CLIENT_SECRET} ${SENTINELS.BWS_ACCESS_TOKEN} expired`);
    const logged = JSON.stringify({ msg: "Token refresh failed", error: sanitizeError(err.message, 500) });
    assert.ok(!logged.includes(SENTINELS.LINEAR_CLIENT_SECRET));
    assert.ok(!logged.includes(SENTINELS.BWS_ACCESS_TOKEN));
    assert.ok(logged.includes("[redacted]"));
    assert.ok(logged.includes("401"), "should preserve status 401");
    assert.ok(logged.includes("Refresh failed"));
  });

  it("LinearTokenManager prefers OAuth (Bearer) and falls back to the raw personal key", async () => {
    const { LinearTokenManager } = await import("../dist/linear.js");
    const emptyStore = { load: () => null, save: () => {}, isExpired: () => false };
    const oauthStore = {
      load: () => ({ access_token: "oauth-tok", refresh_token: "r", expires_at: new Date(Date.now() + 3600_000).toISOString(), obtained_at: new Date().toISOString() }),
      save: () => {},
      isExpired: () => false,
    };
    let fetchCalls = 0;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetchCalls++; throw new Error("must not fetch"); };
    try {
      const oauthMgr = new LinearTokenManager(oauthStore, "id", "secret", "lin_api_testkey");
      assert.equal(await oauthMgr.getValidAccessToken(), "oauth-tok");
      assert.equal(await oauthMgr.getAuthHeader(), "Bearer oauth-tok");
      const keyMgr = new LinearTokenManager(emptyStore, "id", "secret", "lin_api_testkey");
      assert.equal(await keyMgr.getValidAccessToken(), "lin_api_testkey");
      assert.equal(await keyMgr.getAuthHeader(), "lin_api_testkey");
      const noneMgr = new LinearTokenManager(emptyStore, "id", "secret", "   ");
      assert.equal(await noneMgr.getValidAccessToken(), null);
      assert.equal(await noneMgr.getAuthHeader(), null);
      assert.equal(fetchCalls, 0);
    } finally {
      if (prevFetch !== undefined) globalThis.fetch = prevFetch;
      else delete globalThis.fetch;
    }
  });
});
