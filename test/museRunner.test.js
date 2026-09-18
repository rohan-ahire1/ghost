import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMuseJsonl, buildMuseArgs, extractFallbackText, runMuse } from "../dist/museRunner.js";

const validResult = {
  status: "completed",
  summary: "Did work",
  questions: [],
  changed_files: ["src/a.ts"],
  validation_performed: ["test"],
  residual_risks: [],
};

describe("direct Muse runner", () => {
  it("uses Muse 1.3 JSONL with the required safe flags", () => {
    const args = buildMuseArgs({ workspace: "/tmp/work", promptFile: "/tmp/prompt" });
    assert.deepEqual(args.slice(0, 2), ["exec", "--json"]);
    assert.equal(args[args.indexOf("--provider") + 1], "meta");
    assert.equal(args[args.indexOf("--model") + 1], "muse-spark-1.3-contributor");
    for (const flag of ["--parallel-tool-calls", "--trust-workspace", "--no-foreign-personal-context", "--no-session-log"]) {
      assert.ok(args.includes(flag), `missing ${flag}`);
    }
    assert.ok(!args.includes("--user-input-auto-resolve"), "must not combine auto-resolve with --no-session-log");
    const rendered = args.join(" ");
    for (const forbidden of ["sandbox_read-only", "--yolo", "--disable-sandbox", "gpt-5.6-sol", "--strict-config", "--output-schema"]) {
      assert.ok(!rendered.includes(forbidden), `unexpected ${forbidden}`);
    }
  });

  it("defaults to high reasoning effort with full model steps", () => {
    const args = buildMuseArgs({ workspace: "/tmp/work", promptFile: "/tmp/prompt" });
    assert.equal(args[args.indexOf("--reasoning-effort") + 1], "high");
    assert.equal(args[args.indexOf("--max-model-steps") + 1], "50");
  });

  it("honors a reasoning-effort override (fast lane for Q&A)", async () => {
    const args = buildMuseArgs({ workspace: "/tmp/work", promptFile: "/tmp/prompt", reasoningEffort: "low", maxModelSteps: 15 });
    assert.equal(args[args.indexOf("--reasoning-effort") + 1], "low");
    assert.equal(args[args.indexOf("--max-model-steps") + 1], "15");
    let seenArgs = null;
    const mockRunner = async (opts) => {
      seenArgs = opts.args;
      return { stdout: JSON.stringify(validResult), stderr: "", exitCode: 0, timedOut: false, truncated: false };
    };
    await runMuse({ workspace: "/tmp", prompt: "hi", runner: mockRunner, reasoningEffort: "low", maxModelSteps: 15 });
    assert.equal(seenArgs[seenArgs.indexOf("--reasoning-effort") + 1], "low");
    assert.equal(seenArgs[seenArgs.indexOf("--max-model-steps") + 1], "15");
  });

  it("parses single JSONL line with direct result", () => {
    const stdout = JSON.stringify(validResult);
    const parsed = parseMuseJsonl(stdout);
    assert.deepEqual(parsed, validResult);
  });

  it("parses JSONL with wrapper object", () => {
    const wrapped = { output: validResult };
    const stdout = JSON.stringify(wrapped);
    const parsed = parseMuseJsonl(stdout);
    assert.deepEqual(parsed, validResult);
  });

  it("parses multiple JSONL lines, returns last", () => {
    const r1 = { ...validResult, summary: "first" };
    const r2 = { ...validResult, summary: "second" };
    const stdout = [JSON.stringify({ type: "log", msg: "hello" }), JSON.stringify(r1), JSON.stringify(r2)].join("\n");
    const parsed = parseMuseJsonl(stdout);
    assert.equal(parsed.summary, "second");
  });

  it("defensively handles stderr-like mixed text and extracts JSON blob", () => {
    const stdout = `Some log line\nReasoning...\n${JSON.stringify(validResult)}\nMore text`;
    const parsed = parseMuseJsonl(stdout);
    assert.deepEqual(parsed, validResult);
  });

  it("parses nested payload with stringified JSON", () => {
    const inner = JSON.stringify(validResult);
    const outer = JSON.stringify({ payload: inner });
    const parsed = parseMuseJsonl(outer);
    assert.deepEqual(parsed, validResult);
  });

  it("handles blocked status", () => {
    const blocked = { ...validResult, status: "blocked", questions: ["what is X?"] };
    const parsed = parseMuseJsonl(JSON.stringify(blocked));
    assert.equal(parsed.status, "blocked");
    assert.equal(parsed.questions[0], "what is X?");
  });

  it("returns null when no structured result", () => {
    const stdout = JSON.stringify({ msg: "hello", type: "log" }) + "\n" + JSON.stringify({foo: "bar"});
    const parsed = parseMuseJsonl(stdout);
    assert.equal(parsed, null);
  });

  it("handles array wrapper", () => {
    const arr = [validResult];
    const parsed = parseMuseJsonl(JSON.stringify(arr));
    // Our parser tries whole JSON as object; array case via deep find in items? For top-level array, we loop items
    // But our current parser for whole JSON will not directly handle array top-level unless we explicit handle
    // We test that parsing array containing result still finds it via deepFind on array elements
    // The implementation handles array via iterating items after parse
    // If not, we still want null? Let's check.
    // The parser iterates top-level array items.
    // So arr should be found
    assert.deepEqual(parsed, validResult);
  });

  it("extracts from deeply nested structure", () => {
    const deep = { a: { b: { c: { data: validResult } } } };
    const parsed = parseMuseJsonl(JSON.stringify(deep));
    assert.deepEqual(parsed, validResult);
  });

  it("ignores invalid JSON lines", () => {
    const stdout = `not json\n${JSON.stringify(validResult)}\n{ invalid json`;
    const parsed = parseMuseJsonl(stdout);
    assert.deepEqual(parsed, validResult);
  });

  it("handles empty stdout", () => {
    assert.equal(parseMuseJsonl(""), null);
    assert.equal(parseMuseJsonl("   \n   "), null);
  });

  it("extractFallbackText prefers terminal text over deltas", () => {
    const stdout = [
      JSON.stringify({ payload_type: "run.output.delta", payload: { text: "partial " } }),
      JSON.stringify({ payload_type: "run.output.delta", payload: { text: "answer" } }),
      JSON.stringify({ payload_type: "run.terminal.completed", payload: { text: "2 + 2 = 4." } }),
    ].join("\n");
    assert.equal(extractFallbackText(stdout), "2 + 2 = 4.");
  });

  it("extractFallbackText joins deltas when no terminal text exists", () => {
    const stdout = [
      JSON.stringify({ payload_type: "run.output.delta", payload: { text: "hello " } }),
      JSON.stringify({ payload_type: "run.output.delta", payload: { text: "there" } }),
      JSON.stringify({ payload_type: "run.terminal.failed", payload: {} }),
    ].join("\n");
    assert.equal(extractFallbackText(stdout), "hello there");
  });

  it("extractFallbackText handles raw prose and empty output", () => {
    assert.equal(extractFallbackText("just some prose answer"), "just some prose answer");
    assert.equal(extractFallbackText(""), "");
    assert.equal(extractFallbackText("   "), "");
    assert.equal(
      extractFallbackText(JSON.stringify({ payload_type: "run.terminal.failed", payload: {} })),
      "",
    );
  });

  it("runMuse degrades to prose instead of throwing when text exists", async () => {
    const stdout = [
      JSON.stringify({ payload_type: "run.output.delta", payload: { text: "working…" } }),
      JSON.stringify({ payload_type: "run.terminal.completed", payload: { text: "All done, no changes needed." } }),
    ].join("\n");
    const mockRunner = async () => ({ stdout, stderr: "", exitCode: 0, timedOut: false, truncated: false });
    const res = await runMuse({ workspace: "/tmp", prompt: "hi", runner: mockRunner });
    assert.equal(res.status, "completed");
    assert.ok(res.summary.includes("All done"));
    assert.equal(res.questions.length, 0);
    assert.ok(res.residual_risks.some((r) => r.includes("degraded")));
  });

  it("runMuse still throws when there is no text at all", async () => {
    const mockRunner = async () => ({ stdout: "", stderr: "boom", exitCode: 1, timedOut: false, truncated: false });
    await assert.rejects(
      () => runMuse({ workspace: "/tmp", prompt: "hi", runner: mockRunner }),
      /did not return structured output/,
    );
  });

  it("runMuse forwards stdout lines to onProgressLine", async () => {
    const seen = [];
    const mockRunner = async (opts) => {
      opts.onStdoutLine('{"a":1}');
      opts.onStdoutLine('{"b":2}');
      return { stdout: '{"status":"completed","summary":"done","questions":[],"changed_files":[],"validation_performed":[],"residual_risks":[]}', stderr: "", exitCode: 0, timedOut: false, truncated: false };
    };
    const res = await runMuse({ workspace: "/tmp", prompt: "hi", runner: mockRunner, onProgressLine: (l) => seen.push(l) });
    assert.equal(res.status, "completed");
    assert.deepEqual(seen, ['{"a":1}', '{"b":2}']);
  });
});

describe("ProgressTracker", () => {
  const line = (event) => JSON.stringify({ payload: { event } });

  it("maps tool proposed/started/completed to feed items", async () => {
    const { ProgressTracker } = await import("../dist/museRunner.js");
    const t = new ProgressTracker();
    assert.equal(t.feedLine(line({ kind: "proposed", task_id: "t1", task_kind: "tool.bash" })), null);
    assert.equal(t.feedLine(line({ kind: "started", task_id: "t1" })), "▶ bash");
    assert.equal(t.feedLine(line({ kind: "completed", task_id: "t1" })), "✓ bash");
    assert.equal(t.feedLine(line({ kind: "started", task_id: "t2" })), null);
  });

  it("marks failed tools and ignores noise", async () => {
    const { ProgressTracker } = await import("../dist/museRunner.js");
    const t = new ProgressTracker();
    assert.equal(t.feedLine(line({ kind: "proposed", task_id: "t9", task_kind: "tool.edit" })), null);
    assert.equal(t.feedLine(line({ kind: "failed", task_id: "t9" })), "✗ edit");
    assert.equal(t.feedLine("not json"), null);
    assert.equal(t.feedLine(line({ kind: "status", message: "opening stream" })), null);
    assert.equal(t.feedLine(line({ kind: "proposed", task_id: "r1", task_kind: "reminder.agent.plugin:x" })), null);
    assert.equal(t.feedLine(line({ kind: "started", task_id: "r1" })), null);
    assert.equal(t.feedLine(JSON.stringify({ payload: { kind: "run_output_delta", text: "hi" } })), null);
  });

  it("poster sends first item immediately, throttles, then caps", async () => {
    const { ProgressTracker, createProgressPoster } = await import("../dist/museRunner.js");
    const tracker = new ProgressTracker();
    const posted = [];
    let now = 1000;
    const post = createProgressPoster(tracker, (b) => posted.push(b), { minMs: 12_000, maxPosts: 2, now: () => now });
    const toolLine = (kind, id = "t1") => JSON.stringify({ payload: { event: { kind, task_id: id, task_kind: "tool.bash" } } });
    post(toolLine("proposed"));
    post(toolLine("started")); // t=1000: first, immediate
    post(toolLine("completed")); // throttled (same ms)
    now += 12_001;
    post(toolLine("started")); // second, after window
    post(toolLine("completed")); // capped (max 2)
    assert.deepEqual(posted, ["▶ bash", "▶ bash"]);
  });
});
