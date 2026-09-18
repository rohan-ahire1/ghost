import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../dist/jobStore.js";
import { summarizeJob, detailJob, getOpsSnapshot } from "../dist/ops.js";

function makeJob(overrides = {}) {
  const now = new Date().toISOString();
  return {
    sessionId: "sess-1",
    status: "completed",
    followUps: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("ops: job summaries", () => {
  it("summarizeJob keeps metadata and drops prompt bodies", () => {
    const s = summarizeJob(
      makeJob({
        issueIdentifier: "ROH-15",
        issueTitle: "Some title",
        repo: { id: "scoutline", path: "/x", github: "o/r" },
        branch: "ghost/roh-15",
        promptContext: "SECRET PROMPT BODY",
        followUps: ["a", "b", "c"],
        consumedFollowUps: 2,
        summary: "did things",
      }),
    );
    assert.equal(s.sessionId, "sess-1");
    assert.equal(s.repo, "scoutline");
    assert.equal(s.followUpCount, 3);
    assert.equal(s.pendingFollowUps, 1);
    assert.ok(!("promptContext" in s));
    assert.ok(!("followUps" in s));
  });

  it("detailJob adds result fields but never prompt bodies", () => {
    const d = detailJob(
      makeJob({
        promptContext: "SECRET",
        followUps: ["user text"],
        questions: ["q1"],
        changedFiles: ["a.ts"],
        checks: [{ name: "test", ok: true, output: "verbose" }],
        residualRisks: ["r"],
      }),
    );
    assert.deepEqual(d.questions, ["q1"]);
    assert.deepEqual(d.checks, [{ name: "test", ok: true }]);
    assert.ok(!("promptContext" in d));
    assert.ok(!("followUps" in d));
  });

  it("getOpsSnapshot counts by status and surfaces last failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghost-ops-"));
    try {
      const store = new JobStore(dir);
      store.create(makeJob({ sessionId: "a", status: "completed" }));
      store.create(makeJob({ sessionId: "b", status: "failed", error: "boom" }));
      store.create(makeJob({ sessionId: "c", status: "awaiting_input" }));
      const startedAt = new Date(Date.now() - 5000);
      const snap = getOpsSnapshot(store, startedAt);
      assert.equal(snap.service, "ghost");
      assert.equal(snap.jobs.total, 3);
      assert.equal(snap.jobs.byStatus.failed, 1);
      assert.equal(snap.jobs.byStatus.completed, 1);
      assert.equal(snap.jobs.byStatus.awaiting_input, 1);
      assert.equal(snap.lastFailure.sessionId, "b");
      assert.equal(snap.lastFailure.error, "boom");
      assert.equal(snap.recent.length, 3);
      assert.ok(snap.uptimeMs >= 5000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getOpsSnapshot omits lastFailure when nothing failed", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghost-ops-"));
    try {
      const store = new JobStore(dir);
      store.create(makeJob({ sessionId: "a", status: "completed" }));
      const snap = getOpsSnapshot(store, new Date());
      assert.ok(!("lastFailure" in snap));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
