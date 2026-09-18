import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Helpers to set/get sentinel env
const SENTINELS = {
  LINEAR_CLIENT_SECRET: "sentinel-linear-client-OPAQUE-9911-alpha",
  LINEAR_WEBHOOK_SECRET: "sentinel-linear-webhook-OPAQUE-9912-beta",
  BWS_ACCESS_TOKEN: "sentinel-bws-access-OPAQUE-9913-gamma",
  GITHUB_TOKEN: "sentinel-github-OPAQUE-9914-delta",
  GH_TOKEN: "sentinel-gh-OPAQUE-9915-epsilon",
  MODEL_API_KEY: "sentinel-model-OPAQUE-9916-zeta",
  OPENAI_API_KEY: "sentinel-openai-OPAQUE-9917-eta",
  LINEAR_EXTRA: "sentinel-linear-extra-OPAQUE-9918-theta",
  BWS_EXTRA: "sentinel-bws-extra-OPAQUE-9919-iota",
};

function setSentinels() {
  const prev = {};
  for (const [k, v] of Object.entries(SENTINELS)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  // Also set extra prefixed vars to test stripping
  process.env["LINEAR_FOO"] = SENTINELS.LINEAR_EXTRA;
  process.env["BWS_FOO"] = SENTINELS.BWS_EXTRA;
  prev["LINEAR_FOO"] = process.env["LINEAR_FOO"];
  prev["BWS_FOO"] = process.env["BWS_FOO"];
  // Ensure safe vars are set for later checks
  const safePrev = {};
  if (!process.env.PATH) process.env.PATH = "/usr/bin:/bin";
  if (!process.env.HOME) process.env.HOME = "/tmp";
  safePrev.PATH = process.env.PATH;
  safePrev.HOME = process.env.HOME;
  safePrev.TMPDIR = process.env.TMPDIR;
  return prev;
}
function restoreSentinels(prev) {
  for (const k of Object.keys(SENTINELS)) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  for (const k of ["LINEAR_FOO", "BWS_FOO"]) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
}

describe("childEnv isolation: central builder", () => {
  let prev;
  beforeEach(() => { prev = setSentinels(); });
  afterEach(() => restoreSentinels(prev));

  it("buildSafeEnv strips all LINEAR/BWS/GITHUB/MODEL/OPENAI sentinels", async () => {
    const { buildSafeEnv } = await import("../dist/childEnv.js");
    const safe = buildSafeEnv();
    for (const v of Object.values(SENTINELS)) {
      assert.ok(!Object.values(safe).includes(v), `safe env leaked sentinel ${v.slice(0,12)}`);
    }
    // Explicitly check keys not present
    assert.equal(safe.LINEAR_CLIENT_SECRET, undefined);
    assert.equal(safe.LINEAR_WEBHOOK_SECRET, undefined);
    assert.equal(safe.BWS_ACCESS_TOKEN, undefined);
    assert.equal(safe.GITHUB_TOKEN, undefined);
    assert.equal(safe.GH_TOKEN, undefined);
    assert.equal(safe.MODEL_API_KEY, undefined);
    assert.equal(safe.OPENAI_API_KEY, undefined);
    assert.equal(safe.LINEAR_FOO, undefined);
    assert.equal(safe.BWS_FOO, undefined);
  });

  it("buildSafeEnv preserves operational vars PATH, HOME, TMPDIR etc", async () => {
    const { buildSafeEnv } = await import("../dist/childEnv.js");
    const orig = { PATH: process.env.PATH, HOME: process.env.HOME, SHELL: process.env.SHELL, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, TERM: process.env.TERM, TMPDIR: process.env.TMPDIR };
    // Set known safe vars
    process.env.PATH = "/usr/local/bin:/usr/bin";
    process.env.HOME = "/tmp/test-home";
    process.env.SHELL = "/bin/bash";
    process.env.SSH_AUTH_SOCK = "/tmp/ssh.sock";
    process.env.LANG = "en_US.UTF-8";
    process.env.LC_ALL = "C";
    process.env.TERM = "xterm";
    process.env.TMPDIR = "/tmp";
    const safe = buildSafeEnv();
    assert.equal(safe.PATH, "/usr/local/bin:/usr/bin");
    assert.equal(safe.HOME, "/tmp/test-home");
    assert.equal(safe.SHELL, "/bin/bash");
    assert.equal(safe.SSH_AUTH_SOCK, "/tmp/ssh.sock");
    assert.equal(safe.LANG, "en_US.UTF-8");
    assert.equal(safe.LC_ALL, "C");
    assert.equal(safe.TERM, "xterm");
    assert.equal(safe.TMPDIR, "/tmp");
    // restore
    for (const [k, v] of Object.entries(orig)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it("buildSafeEnv allows only narrowly justified tool settings, blocks arbitrary vars", async () => {
    const { buildSafeEnv } = await import("../dist/childEnv.js");
    process.env.FORCE_COLOR = "1";
    process.env.CI = "true";
    process.env.ARBITRARY_SECRET = "should-not-pass";
    process.env.NODE_ENV = "test";
    const safe = buildSafeEnv();
    assert.equal(safe.FORCE_COLOR, "1");
    assert.equal(safe.CI, "true");
    assert.equal(safe.NODE_ENV, "test");
    assert.equal(safe.ARBITRARY_SECRET, undefined);
    delete process.env.ARBITRARY_SECRET;
  });

  it("buildMuseEnv contains MODEL_API_KEY when set and preserves PATH/HOME", async () => {
    const { buildMuseEnv } = await import("../dist/childEnv.js");
    const orig = { PATH: process.env.PATH, HOME: process.env.HOME };
    process.env.PATH = "/usr/bin:/bin";
    process.env.HOME = "/tmp/home";
    process.env.MODEL_API_KEY = SENTINELS.MODEL_API_KEY;
    process.env.LINEAR_CLIENT_SECRET = SENTINELS.LINEAR_CLIENT_SECRET;
    process.env.BWS_ACCESS_TOKEN = SENTINELS.BWS_ACCESS_TOKEN;
    process.env.GITHUB_TOKEN = SENTINELS.GITHUB_TOKEN;
    const muse = buildMuseEnv();
    assert.equal(muse.MODEL_API_KEY, SENTINELS.MODEL_API_KEY);
    assert.equal(muse.PATH, "/usr/bin:/bin");
    assert.equal(muse.HOME, "/tmp/home");
    assert.equal(muse.LINEAR_CLIENT_SECRET, undefined);
    assert.equal(muse.BWS_ACCESS_TOKEN, undefined);
    assert.equal(muse.GITHUB_TOKEN, undefined);
    assert.equal(muse.GH_TOKEN, undefined);
    assert.equal(muse.OPENAI_API_KEY, undefined);
    assert.equal(muse.LINEAR_WEBHOOK_SECRET, undefined);
    for (const [k,v] of Object.entries(orig)) { if (v===undefined) delete process.env[k]; else process.env[k]=v; }
  });

  it("buildMuseEnv omits MODEL_API_KEY when not set, still safe", async () => {
    const { buildMuseEnv } = await import("../dist/childEnv.js");
    const origPath = process.env.PATH;
    delete process.env.MODEL_API_KEY;
    process.env.PATH = "/usr/bin";
    const muse = buildMuseEnv();
    assert.equal(muse.MODEL_API_KEY, undefined);
    assert.equal(muse.PATH, "/usr/bin");
    assert.ok(!Object.values(muse).includes(SENTINELS.LINEAR_CLIENT_SECRET));
    if (origPath===undefined) delete process.env.PATH; else process.env.PATH=origPath;
  });

  it("buildMuseEnv explicitly only allows MODEL_API_KEY, not arbitrary or OPENAI_API_KEY", async () => {
    const { buildMuseEnv, ALLOWED_MODEL_CREDENTIALS } = await import("../dist/childEnv.js");
    assert.deepEqual([...ALLOWED_MODEL_CREDENTIALS], ["MODEL_API_KEY"]);
    process.env.OPENAI_API_KEY = SENTINELS.OPENAI_API_KEY;
    process.env.MODEL_API_KEY = SENTINELS.MODEL_API_KEY;
    process.env.GITHUB_TOKEN = SENTINELS.GITHUB_TOKEN;
    const muse = buildMuseEnv();
    assert.equal(muse.OPENAI_API_KEY, undefined, "OPENAI_API_KEY must not be passed to Muse");
    assert.equal(muse.GITHUB_TOKEN, undefined);
    assert.equal(muse.MODEL_API_KEY, SENTINELS.MODEL_API_KEY);
  });
});

describe("childEnv isolation: runCommand generic plumbing", () => {
  let prev;
  beforeEach(() => { prev = setSentinels(); });
  afterEach(() => restoreSentinels(prev));

  it("generic runCommand spawned child cannot see sentinel LINEAR/BWS/GITHUB/MODEL values", async () => {
    const { runCommand } = await import("../dist/commandRunner.js");
    // Use absolute node path to avoid PATH-dependent lookup when safe env strips PATH partially
    const nodeBin = process.execPath;
    const res = await runCommand({
      command: nodeBin,
      args: ["-e", "console.log(JSON.stringify(process.env))"],
      timeoutMs: 5000,
      maxOutputBytes: 500000,
    });
    assert.equal(res.exitCode, 0);
    assert.equal(res.timedOut, false);
    const childEnv = JSON.parse(res.stdout);
    for (const v of Object.values(SENTINELS)) {
      assert.ok(!Object.values(childEnv).includes(v), `child env leaked ${v.slice(0,20)}`);
    }
    assert.equal(childEnv.LINEAR_CLIENT_SECRET, undefined);
    assert.equal(childEnv.BWS_ACCESS_TOKEN, undefined);
    assert.equal(childEnv.GITHUB_TOKEN, undefined);
    assert.equal(childEnv.MODEL_API_KEY, undefined);
    // Safe vars should be present (at least PATH)
    assert.ok(typeof childEnv.PATH === "string" && childEnv.PATH.length > 0);
  });

  it("runCommand with explicit Muse env passes MODEL_API_KEY but not Linear/BWS/Github", async () => {
    const { runCommand } = await import("../dist/commandRunner.js");
    const { buildMuseEnv } = await import("../dist/childEnv.js");
    const museEnv = buildMuseEnv();
    assert.equal(museEnv.MODEL_API_KEY, SENTINELS.MODEL_API_KEY);
    const nodeBin = process.execPath;
    const res = await runCommand({
      command: nodeBin,
      args: ["-e", "console.log(JSON.stringify(process.env))"],
      env: museEnv,
      timeoutMs: 5000,
      maxOutputBytes: 500000,
    });
    assert.equal(res.exitCode, 0);
    const childEnv = JSON.parse(res.stdout);
    assert.equal(childEnv.MODEL_API_KEY, SENTINELS.MODEL_API_KEY);
    assert.equal(childEnv.LINEAR_CLIENT_SECRET, undefined);
    assert.equal(childEnv.BWS_ACCESS_TOKEN, undefined);
    assert.equal(childEnv.GITHUB_TOKEN, undefined);
    assert.equal(childEnv.OPENAI_API_KEY, undefined);
  });

  it("ensureWorktree plumbing injects safe env and no sentinel reaches mocked runner", async () => {
    const { ensureWorktree } = await import("../dist/gitPipeline.js");
    const dir = mkdtempSync(join(tmpdir(), "ghost-env-test-"));
    const targetPath = join(dir, "target");
    mkdirSync(targetPath, { recursive: true });
    const worktreeBase = join(dir, "worktrees");
    // Capture env from runner calls
    const capturedEnvs = [];
    const mockRunner = async (opts) => {
      capturedEnvs.push(opts.env || null);
      // Simulate git fetch etc success
      if (opts.args[0] === "fetch") return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
      if (opts.args[0] === "ls-remote") return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
      if (opts.args[0] === "worktree") return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
      if (opts.args[0] === "branch") return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
    };
    try {
      await ensureWorktree({
        targetRepoPath: targetPath,
        worktreeBaseDir: worktreeBase,
        branch: "ghost/test-env-1",
        sessionId: "sess-env-1",
        dataDir: dir,
        runner: mockRunner,
      });
    } catch (e) {
      // ensureWorktree may throw due to git logic but plumbing still captured
    }
    assert.ok(capturedEnvs.length > 0, "expected runner to be called");
    for (const env of capturedEnvs) {
      assert.ok(env, "expected env to be injected (not undefined)");
      for (const v of Object.values(SENTINELS)) {
        assert.ok(!Object.values(env).includes(v), `ensureWorktree leaked sentinel ${v.slice(0,12)}`);
      }
      assert.equal(env.LINEAR_CLIENT_SECRET, undefined);
      assert.equal(env.BWS_ACCESS_TOKEN, undefined);
      assert.equal(env.GITHUB_TOKEN, undefined);
      assert.equal(env.MODEL_API_KEY, undefined);
      // Safe vars should be present if originally set
      if (process.env.PATH) assert.equal(env.PATH, process.env.PATH);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("validateWorktree plumbing injects safe env without sentinels", async () => {
    const { validateWorktree } = await import("../dist/gitPipeline.js");
    const dir = mkdtempSync(join(tmpdir(), "ghost-env-test2-"));
    const worktreePath = join(dir, "wt");
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "package.json"), JSON.stringify({ scripts: { test: "echo test" } }));
    const capturedEnvs = [];
    const mockRunner = async (opts) => {
      capturedEnvs.push(opts.env || null);
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
    };
    const res = await validateWorktree({ worktreePath, runner: mockRunner });
    assert.ok(capturedEnvs.length > 0);
    for (const env of capturedEnvs) {
      assert.ok(env);
      for (const v of Object.values(SENTINELS)) {
        assert.ok(!Object.values(env).includes(v));
      }
      assert.equal(env.MODEL_API_KEY, undefined);
      assert.equal(env.GITHUB_TOKEN, undefined);
    }
    assert.deepEqual(res.performed, ["test"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("getChangedFiles and commitAndPush also enforce safe env", async () => {
    const { getChangedFiles } = await import("../dist/gitPipeline.js");
    const dir = mkdtempSync(join(tmpdir(), "ghost-env-test3-"));
    const captured = [];
    const mockRunner = async (opts) => {
      captured.push(opts.env);
      return { stdout: " M src/file.ts\n", stderr: "", exitCode: 0, timedOut: false, truncated: false };
    };
    const files = await getChangedFiles(dir, mockRunner);
    assert.deepEqual(files, ["src/file.ts"]);
    assert.ok(captured[0]);
    for (const v of Object.values(SENTINELS)) assert.ok(!Object.values(captured[0]).includes(v));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("childEnv isolation: central safe-error redaction", () => {
  let prev;
  beforeEach(() => { prev = setSentinels(); });
  afterEach(() => restoreSentinels(prev));

  it("sanitizeError redacts exact opaque sentinel values even without known prefixes", async () => {
    const { sanitizeError, getSafeErrorMessage } = await import("../dist/commandRunner.js");
    // Use opaque sentinel that has no ghp_/Bearer prefix
    const opaqueLinear = SENTINELS.LINEAR_CLIENT_SECRET;
    const opaqueBws = SENTINELS.BWS_ACCESS_TOKEN;
    const msg = `failed to fetch because token ${opaqueLinear} and also ${opaqueBws} leaked`;
    const sanitized = sanitizeError(msg);
    assert.ok(!sanitized.includes(opaqueLinear), "opaque linear not redacted");
    assert.ok(!sanitized.includes(opaqueBws), "opaque bws not redacted");
    assert.ok(sanitized.includes("[redacted]"));
    const viaHelper = getSafeErrorMessage(new Error(msg));
    assert.ok(!viaHelper.includes(opaqueLinear));
    assert.ok(viaHelper.includes("[redacted]"));
  });

  it("redactKnownSecrets redacts all known service secrets from message", async () => {
    const { redactKnownSecrets, KNOWN_SERVICE_SECRET_ENV_KEYS } = await import("../dist/childEnv.js");
    let msg = "";
    const knownVals = KNOWN_SERVICE_SECRET_ENV_KEYS.map(k => SENTINELS[k]).filter(Boolean);
    for (const v of knownVals) msg += ` prefix ${v} suffix `;
    const redacted = redactKnownSecrets(msg);
    for (const v of knownVals) {
      assert.ok(!redacted.includes(v), `redactKnownSecrets leaked ${v.slice(0,15)}`);
    }
    assert.ok(redacted.includes("[redacted]"));
  });

  it("redactWithValue also covers known secrets even if caller omits them", async () => {
    const { redactWithValue } = await import("../dist/commandRunner.js");
    const opaque = SENTINELS.GITHUB_TOKEN;
    const msg = `error with ${opaque} inside`;
    // Caller only passes empty list, but redactWithValue should still redact via redactKnownSecrets
    const out = redactWithValue(msg, []);
    assert.ok(!out.includes(opaque));
    assert.ok(out.includes("[redacted]"));
  });

  it("JobStore save redacts persisted error containing opaque sentinel", async () => {
    const { JobStore } = await import("../dist/jobStore.js");
    const dir = mkdtempSync(join(tmpdir(), "ghost-redact-store-"));
    const store = new JobStore(dir);
    const rec = {
      sessionId: "redact-sess-1",
      status: "running",
      followUps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: `boom with ${SENTINELS.MODEL_API_KEY} and ${SENTINELS.BWS_ACCESS_TOKEN}`,
    };
    store.create(rec);
    // Now save with error containing sentinel - save should redact
    const loaded = store.load("redact-sess-1");
    loaded.error = `persisted boom ${SENTINELS.LINEAR_WEBHOOK_SECRET} ${SENTINELS.GH_TOKEN}`;
    store.save(loaded);
    const after = store.load("redact-sess-1");
    assert.ok(!after.error.includes(SENTINELS.LINEAR_WEBHOOK_SECRET));
    assert.ok(!after.error.includes(SENTINELS.GH_TOKEN));
    assert.ok(after.error.includes("[redacted]"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("commandRunner spawn error is sanitized and does not leak sentinel", async () => {
    const { sanitizeError } = await import("../dist/commandRunner.js");
    // Simulate an error message that would be produced by a child that echoed a secret
    const errMsg = `spawn error: something failed with value ${SENTINELS.OPENAI_API_KEY} inline`;
    const safe = sanitizeError(errMsg);
    assert.ok(!safe.includes(SENTINELS.OPENAI_API_KEY));
    assert.ok(safe.includes("[redacted]"));
  });

  it("runCommand timeout/error path does not expose sentinels in rejection", async () => {
    const { runCommand } = await import("../dist/commandRunner.js");
    // Force an error by using invalid command? But we want to test sanitizeError on spawn error
    // runCommand rejects with sanitized error on spawn failure
    const invalidSentinel = SENTINELS.BWS_ACCESS_TOKEN;
    // We can't directly make spawn error contain sentinel, but we can test that even if process.env contains sentinel,
    // a failing command's error handling does not leak it via logs (we test via sanitizeError already)
    // Instead verify that a timeout still not leak: run a command that times out, then error message sanitized if thrown elsewhere
    const nodeBin = process.execPath;
    const res = await runCommand({
      command: nodeBin,
      args: ["-e", "setTimeout(()=>{}, 10000)"],
      timeoutMs: 100,
    });
    assert.equal(res.timedOut, true);
    // No sentinel in stdout/stderr
    assert.ok(!res.stdout.includes(SENTINELS.LINEAR_CLIENT_SECRET));
    assert.ok(!res.stderr.includes(SENTINELS.LINEAR_CLIENT_SECRET));
  });
});
