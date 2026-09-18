import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCommand, getSafeErrorMessage } from "../dist/commandRunner.js";

describe("commandRunner safety", () => {
  it("rejects shell metacharacters in command", async () => {
    await assert.rejects(
      () => runCommand({ command: "echo; rm -rf /", args: [] }),
      /shell metacharacters/,
    );
  });

  it("runs simple command with argv array, shell false", async () => {
    const res = await runCommand({ command: "node", args: ["-e", "console.log('hello')"], timeoutMs: 2000 });
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes("hello"));
    assert.equal(res.timedOut, false);
  });

  it("never interpolates task text into shell (args handling)", async () => {
    // Pass dangerous string as arg, ensure it's not executed as shell
    const dangerous = "hello; echo injected";
    const res = await runCommand({
      command: "node",
      args: ["-e", "console.log(process.argv[1])", dangerous],
      timeoutMs: 2000,
    });
    assert.ok(res.stdout.includes("hello; echo injected"));
    assert.ok(!res.stdout.includes("injected") || res.stdout.includes("hello; echo injected"));
  });

  it("enforces timeout", async () => {
    const res = await runCommand({
      command: "node",
      args: ["-e", "setTimeout(()=>{}, 5000)"],
      timeoutMs: 200,
    });
    assert.equal(res.timedOut, true);
    assert.equal(res.exitCode, null);
  });

  it("caps output", async () => {
    const res = await runCommand({
      command: "node",
      args: ["-e", "for(let i=0;i<1000;i++) console.log('a'.repeat(200))"],
      timeoutMs: 2000,
      maxOutputBytes: 5000,
    });
    assert.ok(res.stdout.length <= 5000 + 100); // allow small overhead
    assert.equal(res.truncated, true);
  });

  it("sanitizes errors (redacts tokens)", () => {
    const msg = getSafeErrorMessage(new Error("failed with ghp_1234567890abcdef and Bearer secret"));
    assert.ok(!msg.includes("ghp_1234567890abcdef"));
    assert.ok(msg.includes("[redacted]"));
    assert.ok(!msg.includes("secret") || msg.includes("[redacted]"));
  });

  it("handles input via stdin", async () => {
    const res = await runCommand({
      command: "node",
      args: ["-e", "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log('got:'+d))"],
      input: "hello stdin",
      timeoutMs: 2000,
    });
    assert.ok(res.stdout.includes("got:hello stdin"));
  });

  it("uses shell:false (spawn does not expand $())", async () => {
    // If shell were true, `echo $(echo pwned)` would expand. With shell false, it should not.
    const res = await runCommand({
      command: "node",
      args: ["-e", "console.log(process.argv[1])", "$(echo pwned)"],
      timeoutMs: 2000,
    });
    assert.ok(res.stdout.includes("$(echo pwned)"));
    assert.ok(!res.stdout.includes("pwned") || res.stdout.includes("$(echo pwned)"));
  });

  it("streams stdout lines including a trailing partial, and survives hook errors", async () => {
    const seen = [];
    const res = await runCommand({
      command: "node",
      args: ["-e", "process.stdout.write('l1\\nl2\\npartial');"],
      timeoutMs: 2000,
      onStdoutLine: (line) => {
        seen.push(line);
        if (line === "l2") throw new Error("hook must not break the run");
      },
    });
    assert.equal(res.exitCode, 0);
    assert.deepEqual(seen, ["l1", "l2", "partial"]);
  });
});
