import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { museLimiter, getMaxConcurrentMuse } from "../dist/limiter.js";
import { pruneOldData } from "../dist/jobStore.js";

describe("limiter: muse concurrency cap", () => {
  const orig = process.env.GHOST_MAX_CONCURRENT_MUSE;
  afterEach(() => {
    museLimiter._reset();
    if (orig === undefined) delete process.env.GHOST_MAX_CONCURRENT_MUSE;
    else process.env.GHOST_MAX_CONCURRENT_MUSE = orig;
  });

  it("defaults to 2 and clamps bad values", () => {
    delete process.env.GHOST_MAX_CONCURRENT_MUSE;
    assert.equal(getMaxConcurrentMuse(), 2);
    process.env.GHOST_MAX_CONCURRENT_MUSE = "junk";
    assert.equal(getMaxConcurrentMuse(), 2);
    process.env.GHOST_MAX_CONCURRENT_MUSE = "99";
    assert.equal(getMaxConcurrentMuse(), 8);
  });

  it("serializes runs at cap 1 in FIFO order", async () => {
    process.env.GHOST_MAX_CONCURRENT_MUSE = "1";
    const order = [];
    const slow = museLimiter.run(async () => {
      order.push("slow-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("slow-end");
      return "slow";
    });
    const fast = museLimiter.run(async () => {
      order.push("fast");
      return "fast";
    });
    assert.deepEqual(await Promise.all([slow, fast]), ["slow", "fast"]);
    assert.deepEqual(order, ["slow-start", "slow-end", "fast"]);
  });
});

describe("retention: pruneOldData", () => {
  it("removes only entries older than the cutoff", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghost-prune-"));
    try {
      const now = Date.now();
      const old = new Date(now - 31 * 24 * 60 * 60 * 1000);
      mkdirSync(join(dir, "jobs"), { recursive: true });
      mkdirSync(join(dir, "scratch", "old-sess"), { recursive: true });
      mkdirSync(join(dir, "scratch", "new-sess"), { recursive: true });
      writeFileSync(join(dir, "jobs", "old.json"), "{}");
      writeFileSync(join(dir, "jobs", "new.json"), "{}");
      writeFileSync(join(dir, "jobs", "notes.txt"), "keep me");
      writeFileSync(join(dir, "tokens.json"), "{}");
      utimesSync(join(dir, "jobs", "old.json"), old, old);
      utimesSync(join(dir, "scratch", "old-sess"), old, old);
      const removed = pruneOldData(dir, 30, now);
      assert.deepEqual(removed, { jobs: 1, scratch: 1, worktrees: 0 });
      assert.ok(!existsSync(join(dir, "jobs", "old.json")));
      assert.ok(existsSync(join(dir, "jobs", "new.json")));
      assert.ok(existsSync(join(dir, "jobs", "notes.txt")));
      assert.ok(existsSync(join(dir, "tokens.json")));
      assert.ok(!existsSync(join(dir, "scratch", "old-sess")));
      assert.ok(existsSync(join(dir, "scratch", "new-sess")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tolerates a missing data dir", () => {
    const removed = pruneOldData(join(tmpdir(), "ghost-prune-missing-xyz"), 30);
    assert.deepEqual(removed, { jobs: 0, scratch: 0, worktrees: 0 });
  });
});
