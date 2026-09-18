import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildChatPrompt, parseChatGate, runChatGate } from "../dist/chat.js";

describe("chat gate prompt", () => {
  it("sends only the message and ticket id", () => {
    const p = buildChatPrompt({ ticketId: "ROH-15", message: "hi there", history: [] });
    assert.ok(p.includes("hi there"));
    assert.ok(p.includes("ROH-15"));
  });

  it("ignores ticket body even if passed", () => {
    const p = buildChatPrompt({ ticketId: "ROH-15", message: "hi", history: [], promptContext: "CANARY-TICKET-BODY" });
    assert.ok(!p.includes("CANARY-TICKET-BODY"));
  });

  it("includes capped conversation history", () => {
    const history = ["user: first question", "ghost: first answer"];
    const p = buildChatPrompt({ ticketId: "R", message: "follow-up", history });
    assert.ok(p.includes("first question"));
    assert.ok(p.includes("follow-up"));
    const big = Array.from({ length: 50 }, (_, i) => `user: message number ${i} `.padEnd(500, "x"));
    const capped = buildChatPrompt({ ticketId: "R", message: "hi", history: big });
    assert.ok(capped.length < 6000, `history must be bounded, got ${capped.length}`);
  });
});

describe("chat gate parsing", () => {
  it("parses fetch decisions from JSONL", () => {
    const g = parseChatGate('{"payload_type":"x"}\n{"mode":"fetch","reply":""}');
    assert.deepEqual(g, { mode: "fetch", reply: "" });
  });

  it("parses chat decisions with reply", () => {
    const g = parseChatGate('noise\n{"mode":"chat","reply":"Hey, doing well!"}');
    assert.deepEqual(g, { mode: "chat", reply: "Hey, doing well!" });
  });

  it("treats prose as a chat reply", () => {
    const g = parseChatGate("Hey there, how can I help?");
    assert.deepEqual(g, { mode: "chat", reply: "Hey there, how can I help?" });
  });

  it("fails closed to chat on unknown modes", () => {
    const g = parseChatGate('{"mode":"work","reply":"starting"}');
    assert.equal(g.mode, "chat");
  });

  it("returns null when there is no usable text", () => {
    assert.equal(parseChatGate(""), null);
    assert.equal(parseChatGate("   \n  "), null);
  });
});

describe("chat gate runner", () => {
  it("invokes muse cheaply in the given workspace", async () => {
    let seen = null;
    const runner = async (opts) => {
      seen = opts;
      return { stdout: '{"mode":"chat","reply":"yo"}', stderr: "", exitCode: 0, timedOut: false, truncated: false };
    };
    const g = await runChatGate({
      workspace: "/tmp/chat-ws",
      ticketId: "ROH-1",
      message: "hi",
      history: [],
      runner,
      museBin: "/bin/muse",
    });
    assert.deepEqual(g, { mode: "chat", reply: "yo" });
    assert.ok(seen.args.includes("/tmp/chat-ws"));
    const effort = seen.args[seen.args.indexOf("--reasoning-effort") + 1];
    assert.equal(effort, "low");
    const steps = seen.args[seen.args.indexOf("--max-model-steps") + 1];
    assert.equal(steps, "15");
  });

  it("throws when the model returns nothing usable", async () => {
    const runner = async () => ({ stdout: "", stderr: "oops", exitCode: 1, timedOut: false, truncated: false });
    await assert.rejects(() => runChatGate({ workspace: "/tmp/x", message: "hi", history: [], runner, museBin: "/bin/muse" }));
  });
});
