import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAgentSessionCreated, handleAgentSessionPrompted } from "../dist/agentSession.js";
import { JobStore } from "../dist/jobStore.js";

function mockTokenManager() {
  return {
    getValidAccessToken: async () => "fake-token", getAuthHeader: async () => "Bearer [REDACTED]",
  };
}

const mustNotRunMuse = async () => { throw new Error("muse must not run on this turn"); };

describe("chat-first pipeline", () => {
  let dir;
  let activities;
  let mockCreateActivity;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ghost-chatfirst-"));
    activities = [];
    mockCreateActivity = async ({ agentSessionId, content }) => {
      activities.push({ agentSessionId, content });
      return true;
    };
    process.env.GHOST_DATA_DIR = dir;
    mkdirSync(join(dir, "worktrees"), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    delete process.env.GHOST_DATA_DIR;
    delete process.env.GHOST_DEFAULT_REPO;
    delete process.env.GHOST_REPO_SCOUTLINE_PATH;
    delete process.env.GHOST_PROJECT_MAP;
  });

  function ctxFor(overrides = {}) {
    return {
      agentSessionId: "chat-sess-1",
      initialPrompt: "hi",
      issueIdentifier: "ROH-15",
      issueTitle: "Preserve unknown metrics",
      promptContext: "SECRET-TICKET-BODY ".repeat(200),
      rawPayload: {},
      ...overrides,
    };
  }

  it("'hi' gets a plain reply: no ticket context, no muse work call, no worktree", async () => {
    let chatSeen = null;
    const chatRunner = async (opts) => {
      chatSeen = opts;
      return { mode: "chat", reply: "Hey! How can I help?" };
    };
    await handleAgentSessionCreated(ctxFor(), mockTokenManager(), {
      dataDir: dir,
      createActivity: mockCreateActivity,
      chatRunner,
      museRunner: mustNotRunMuse,
    });
    // Chat gate saw the message and ticket id only
    assert.equal(chatSeen.message, "hi");
    assert.equal(chatSeen.ticketId, "ROH-15");
    assert.ok(!JSON.stringify(chatSeen).includes("SECRET-TICKET-BODY"));
    // One bare response, no work announcement
    assert.equal(activities.length, 1);
    assert.equal(activities[0].content.type, "response");
    assert.equal(activities[0].content.body, "Hey! How can I help?");
    const job = new JobStore(dir).load("chat-sess-1");
    assert.equal(job.status, "completed");
    assert.equal(readdirSync(join(dir, "worktrees")).length, 0);
  });

  it("fetch + answer posts the ticket-grounded answer without repo work", async () => {
    let musePrompt = "";
    const chatRunner = async () => ({ mode: "fetch", reply: "" });
    const museRunner = async (opts) => {
      musePrompt = opts.prompt;
      return { status: "completed", summary: "The ticket asks for metric labels.", questions: [], changed_files: [], validation_performed: [], residual_risks: [] };
    };
    await handleAgentSessionCreated(ctxFor({ initialPrompt: "summarize this ticket" }), mockTokenManager(), {
      dataDir: dir,
      createActivity: mockCreateActivity,
      chatRunner,
      museRunner,
    });
    // Work stage DID receive the ticket body
    assert.ok(musePrompt.includes("SECRET-TICKET-BODY"));
    const responses = activities.filter((a) => a.content.type === "response");
    assert.equal(responses.length, 1);
    assert.ok(responses[0].content.body.includes("metric labels"));
    assert.equal(readdirSync(join(dir, "worktrees")).length, 0);
    assert.equal(new JobStore(dir).load("chat-sess-1").status, "completed");
  });

  it("fetch + work runs the repo pipeline only when the model asks for work", async () => {
    const { runCommand } = await import("../dist/commandRunner.js");
    const fakeRepoPath = join(dir, "fake-scoutline");
    mkdirSync(fakeRepoPath, { recursive: true });
    await runCommand({ command: "git", args: ["init"], cwd: fakeRepoPath, timeoutMs: 5000 });
    await runCommand({ command: "git", args: ["config", "user.email", "ghost@test.com"], cwd: fakeRepoPath, timeoutMs: 2000 });
    await runCommand({ command: "git", args: ["config", "user.name", "Ghost"], cwd: fakeRepoPath, timeoutMs: 2000 });
    writeFileSync(join(fakeRepoPath, "README.md"), "# test");
    await runCommand({ command: "git", args: ["add", "."], cwd: fakeRepoPath, timeoutMs: 2000 });
    await runCommand({ command: "git", args: ["commit", "-m", "init"], cwd: fakeRepoPath, timeoutMs: 2000 });
    await runCommand({ command: "git", args: ["branch", "-M", "main"], cwd: fakeRepoPath, timeoutMs: 2000 });
    const originPath = join(dir, "origin.git");
    mkdirSync(originPath, { recursive: true });
    await runCommand({ command: "git", args: ["init", "--bare", originPath], timeoutMs: 5000 });
    await runCommand({ command: "git", args: ["remote", "add", "origin", originPath], cwd: fakeRepoPath, timeoutMs: 2000 });
    await runCommand({ command: "git", args: ["push", "-u", "origin", "main"], cwd: fakeRepoPath, timeoutMs: 5000 });
    process.env.GHOST_REPO_SCOUTLINE_PATH = fakeRepoPath;

    const chatRunner = async () => ({ mode: "fetch", reply: "" });
    const museRunner = async (opts) => {
      if (opts.workspace.includes("scratch")) {
        return { status: "completed", summary: "Needs a code change.", questions: [], changed_files: [], validation_performed: [], residual_risks: [], wants_work: true };
      }
      return { status: "completed", summary: "mocked work done", questions: [], changed_files: [], validation_performed: [], residual_risks: [] };
    };
    await handleAgentSessionCreated(
      ctxFor({ agentSessionId: "work-sess-1", initialPrompt: "work on this feature", issueTitle: "scoutline widget" }),
      mockTokenManager(),
      {
        dataDir: dir,
        runner: runCommand,
        createActivity: mockCreateActivity,
        chatRunner,
        museRunner,
        fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify([]) }),
      },
    );
    const job = new JobStore(dir).load("work-sess-1");
    assert.equal(job.status, "completed");
    assert.equal(job.repo.id, "scoutline");
    assert.ok(job.branch.startsWith("ghost/"));
  });

  it("fetch + work with an ambiguous repo asks which repo instead of guessing", async () => {
    const chatRunner = async () => ({ mode: "fetch", reply: "" });
    const museRunner = async () => ({
      status: "completed", summary: "Needs a code change.", questions: [],
      changed_files: [], validation_performed: [], residual_risks: [], wants_work: true,
    });
    await handleAgentSessionCreated(
      ctxFor({ agentSessionId: "amb-sess-1", initialPrompt: "work on this", issueTitle: "scoutline and flaggo" }),
      mockTokenManager(),
      { dataDir: dir, createActivity: mockCreateActivity, chatRunner, museRunner },
    );
    const job = new JobStore(dir).load("amb-sess-1");
    assert.equal(job.status, "awaiting_input");
    const elicitations = activities.filter((a) => a.content.type === "elicitation");
    assert.equal(elicitations.length, 1);
    assert.equal(readdirSync(join(dir, "worktrees")).length, 0);
  });

  it("chat gate failure fails the job truthfully", async () => {
    const chatRunner = async () => { throw new Error("gate exploded"); };
    await handleAgentSessionCreated(ctxFor({ agentSessionId: "fail-sess-1" }), mockTokenManager(), {
      dataDir: dir,
      createActivity: mockCreateActivity,
      chatRunner,
      museRunner: mustNotRunMuse,
    });
    const job = new JobStore(dir).load("fail-sess-1");
    assert.equal(job.status, "failed");
    assert.ok(job.error.includes("gate exploded"));
    assert.ok(activities.some((a) => a.content.type === "error"));
  });

  it("follow-ups carry conversation history into the chat gate", async () => {
    const seenMessages = [];
    const chatRunner = async (opts) => {
      seenMessages.push(opts);
      return { mode: "chat", reply: `echo:${opts.message}` };
    };
    await handleAgentSessionCreated(ctxFor({ agentSessionId: "hist-sess-1", initialPrompt: "hi" }), mockTokenManager(), {
      dataDir: dir,
      createActivity: mockCreateActivity,
      chatRunner,
      museRunner: mustNotRunMuse,
    });
    await handleAgentSessionPrompted(
      { agentSession: { id: "hist-sess-1" }, agentActivity: { content: { type: "prompt", body: "do the thing" } } },
      mockTokenManager(),
      { dataDir: dir, createActivity: mockCreateActivity, chatRunner, museRunner: mustNotRunMuse },
    );
    assert.equal(seenMessages.length, 2);
    assert.equal(seenMessages[1].message, "do the thing");
    assert.ok(JSON.stringify(seenMessages[1].history).includes("echo:hi"));
  });
});
