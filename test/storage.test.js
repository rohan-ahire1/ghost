import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebhookReplayStore } from "../dist/storage.js";

describe("storage: WebhookReplayStore", () => {
  it("dedupes within one instance", () => {
    const s = new WebhookReplayStore();
    assert.equal(s.checkAndMark("abc"), true);
    assert.equal(s.checkAndMark("abc"), false);
    assert.equal(s.checkAndMark(""), true);
  });

  it("persists across restarts when given a dataDir", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghost-replay-"));
    try {
      const a = new WebhookReplayStore(dir);
      assert.equal(a.checkAndMark("delivery-1"), true);
      assert.ok(existsSync(join(dir, "webhook-deliveries.json")));
      // Simulate restart: a new instance must still reject the same id
      const b = new WebhookReplayStore(dir);
      assert.equal(b.checkAndMark("delivery-1"), false);
      assert.equal(b.checkAndMark("delivery-2"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persisted file is 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghost-replay-"));
    try {
      const a = new WebhookReplayStore(dir);
      a.checkAndMark("x");
      const mode = statSync(join(dir, "webhook-deliveries.json")).mode & 0o777;
      assert.equal(mode, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("corrupt persistence file does not crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghost-replay-"));
    try {
      writeFileSync(join(dir, "webhook-deliveries.json"), "{corrupt");
      const s = new WebhookReplayStore(dir);
      assert.equal(s.checkAndMark("y"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
