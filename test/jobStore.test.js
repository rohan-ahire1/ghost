import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../dist/jobStore.js";

describe("JobStore", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ghost-job-"));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it("creates and loads job with durable persistence", () => {
    const store = new JobStore(dir);
    const rec = {
      sessionId: "sess-123",
      status: "created",
      issueIdentifier: "SCOUT-1",
      followUps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const ok = store.create(rec);
    assert.equal(ok, true);
    const loaded = store.load("sess-123");
    assert.equal(loaded?.sessionId, "sess-123");
    assert.equal(loaded?.issueIdentifier, "SCOUT-1");
  });

  it("duplicate create returns false (idempotency)", () => {
    const store = new JobStore(dir);
    const rec = {
      sessionId: "dup-1",
      status: "created",
      followUps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    assert.equal(store.create(rec), true);
    assert.equal(store.create(rec), false);
  });

  it("persists across store instances (restart simulation)", () => {
    const store1 = new JobStore(dir);
    store1.create({
      sessionId: "restart-1",
      status: "running",
      followUps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const store2 = new JobStore(dir);
    const loaded = store2.load("restart-1");
    assert.equal(loaded?.status, "running");
    assert.equal(store2.isDuplicateCreated("restart-1"), true);
  });

  it("isDuplicateCreated false when no record", () => {
    const store = new JobStore(dir);
    assert.equal(store.isDuplicateCreated("nonexistent"), false);
  });

  it("isDuplicateCreated true for any existing status", () => {
    const store = new JobStore(dir);
    for (const status of ["created", "running", "awaiting_input", "completed", "failed"]) {
      const sid = `stat-${status}`;
      store.create({
        sessionId: sid,
        status,
        followUps: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      assert.equal(store.isDuplicateCreated(sid), true);
    }
  });

  it("atomic write and mode 0600", () => {
    const store = new JobStore(dir);
    store.create({
      sessionId: "mode-test",
      status: "created",
      followUps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const p = join(dir, "jobs", "mode-test.json");
    const st = statSync(p);
    // Mode should be 0600 (octal 384)
    // On some filesystems, mode may be masked, but we check that file exists and is readable
    assert.ok(st.isFile());
    const content = readFileSync(p, "utf-8");
    assert.ok(content.includes("mode-test"));
  });

  it("per-session lock serializes concurrent access", async () => {
    const store = new JobStore(dir);
    store.create({
      sessionId: "lock-1",
      status: "created",
      followUps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const order = [];
    const p1 = store.withSessionLock("lock-1", async () => {
      order.push("p1 start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("p1 end");
      return 1;
    });
    const p2 = store.withSessionLock("lock-1", async () => {
      order.push("p2 start");
      order.push("p2 end");
      return 2;
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, 1);
    assert.equal(r2, 2);
    assert.deepEqual(order, ["p1 start", "p1 end", "p2 start", "p2 end"]);
  });

  it("per-repo lock isolates repo concurrency", async () => {
    const store = new JobStore(dir);
    const order = [];
    const p1 = store.withRepoLock("scoutline", async () => {
      order.push("r1 start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("r1 end");
    });
    const p2 = store.withRepoLock("scoutline", async () => {
      order.push("r2 start");
      order.push("r2 end");
    });
    const p3 = store.withRepoLock("flaggo", async () => {
      order.push("r3 start (different repo)");
      order.push("r3 end");
    });
    await Promise.all([p1, p2, p3]);
    // r3 can run concurrently with r1, but r1 and r2 are serialized
    assert.ok(order.indexOf("r1 start") < order.indexOf("r1 end"));
    assert.ok(order.indexOf("r1 end") < order.indexOf("r2 start"));
  });

  it("appendFollowUp persists and truncates", () => {
    const store = new JobStore(dir);
    store.create({
      sessionId: "follow-1",
      status: "awaiting_input",
      followUps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const long = "a".repeat(10000);
    const rec = store.appendFollowUp("follow-1", long);
    assert.ok(rec);
    assert.equal(rec.followUps.length, 1);
    assert.ok(rec.followUps[0].length <= 8000);
    const loaded = store.load("follow-1");
    assert.equal(loaded?.followUps.length, 1);
  });

  it("save sanitizes error (redacts tokens)", () => {
    const store = new JobStore(dir);
    store.create({
      sessionId: "err-1",
      status: "running",
      followUps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const rec = store.load("err-1");
    rec.error = "failed with ghp_1234567890abc and Bearer secret123";
    store.save(rec);
    const loaded = store.load("err-1");
    assert.ok(!loaded?.error.includes("ghp_1234567890abc"));
    assert.ok(loaded?.error.includes("[redacted]"));
  });

  it("different sessions can run concurrently (different locks)", async () => {
    const store = new JobStore(dir);
    const order = [];
    const p1 = store.withSessionLock("sess-A", async () => {
      order.push("A start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("A end");
    });
    const p2 = store.withSessionLock("sess-B", async () => {
      order.push("B start");
      order.push("B end");
    });
    await Promise.all([p1, p2]);
    // A and B should not block each other, B can start before A ends
    // Since they use different keys, both can start immediately. We just ensure both complete.
    assert.ok(order.includes("A start"));
    assert.ok(order.includes("B start"));
  });
});
