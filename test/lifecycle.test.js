import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAgentSessionCreated, handleAgentSessionPrompted, extractGhostContext } from "../dist/agentSession.js";
import { JobStore } from "../dist/jobStore.js";

// Mock token manager
function mockTokenManager() {
  return {
    getValidAccessToken: async () => "fake-token", getAuthHeader: async () => "Bearer fake-token",
  };
}

describe("lifecycle: created/prompted", () => {
  let dir;
  let activities;
  let mockCreateActivity;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ghost-lifecycle-"));
    activities = [];
    mockCreateActivity = async ({ accessToken, agentSessionId, content }) => {
      activities.push({ agentSessionId, content });
      return true;
    };
    // Ensure env data dir points to temp
    process.env.GHOST_DATA_DIR = dir;
    // Create isolated worktree base
    mkdirSync(join(dir, "worktrees"), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    delete process.env.GHOST_DATA_DIR;
    delete process.env.GHOST_DEFAULT_REPO;
  });

  it("duplicate created deliveries do not start job twice (idempotency)", async () => {
    const fakeRunner = async () => { throw new Error("should not be called for duplicate test"); };
    // Need to mock full pipeline to avoid real git/muse. We'll make a runner that would fail if called, but duplicate check happens before runner?
    // For first created, we need to simulate repo resolution that needs elicitation (no runner needed). Use no repo path to trigger elicitation, not runner.
    // But to test duplicate, we need first call to succeed in creating job, second to be detected as duplicate.

    const ctx1 = {
      agentSessionId: "dup-sess-1",
      initialPrompt: "fix scoutline",
      issueIdentifier: "SCOUT-1",
      issueTitle: "scoutline bug",
      promptContext: "fix scoutline",
      rawPayload: {},
    };

    // Mock muse and git to avoid real execution - we need to provide deps that avoid runner.
    // Instead, we will let pipeline run but mock museRunner to return quickly and mock git via runner that pretends worktree exists?
    // Simpler: Test JobStore duplicate directly via handleAgentSessionCreated with mocked dependencies that simulate quick success.

    // Create a mock runner that simulates git fetch/worktree and muse not needed? For this test, we want first call to complete worktree but we can mock ensureWorktree via runner.
    // Instead, we can test the duplicate detection at JobStore level via handleAgentSessionCreated's early duplicate check before heavy work.
    // To avoid heavy work, we make resolver return ambigious? No, we want success path but mocked.

    // Simplify: Call handleAgentSessionCreated twice with a repo that resolves but with mocked runner that simulates everything including muse.

    // Create fake repo directories to avoid git failures? We can set GHOST_REPO_SCOUTLINE_PATH to a temp git repo.
    // Create a minimal git repo for scoutline
    const fakeRepoPath = join(dir, "fake-scoutline");
    mkdirSync(fakeRepoPath, { recursive: true });
    // Init git repo with origin/main
    const { runCommand } = await import("../dist/commandRunner.js");
    await runCommand({ command: "git", args: ["init"], cwd: fakeRepoPath, timeoutMs: 5000 });
    await runCommand({ command: "git", args: ["config", "user.email", "ghost@test.com"], cwd: fakeRepoPath, timeoutMs: 2000 });
    await runCommand({ command: "git", args: ["config", "user.name", "Ghost"], cwd: fakeRepoPath, timeoutMs: 2000 });
    // Create initial commit and branch main
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(fakeRepoPath, "README.md"), "# test");
    await runCommand({ command: "git", args: ["add", "."], cwd: fakeRepoPath, timeoutMs: 2000 });
    await runCommand({ command: "git", args: ["commit", "-m", "init"], cwd: fakeRepoPath, timeoutMs: 2000 });
    await runCommand({ command: "git", args: ["branch", "-M", "main"], cwd: fakeRepoPath, timeoutMs: 2000 });
    // Create bare origin and push
    const originPath = join(dir, "origin.git");
    mkdirSync(originPath, { recursive: true });
    await runCommand({ command: "git", args: ["init", "--bare", originPath], timeoutMs: 5000 });
    await runCommand({ command: "git", args: ["remote", "add", "origin", originPath], cwd: fakeRepoPath, timeoutMs: 2000 });
    await runCommand({ command: "git", args: ["push", "-u", "origin", "main"], cwd: fakeRepoPath, timeoutMs: 5000 });

    process.env.GHOST_REPO_SCOUTLINE_PATH = fakeRepoPath;

    // Mock muse to return completed without needing real muse binary
    const mockMuse = async () => ({
      status: "completed",
      summary: "mocked completed",
      questions: [],
      changed_files: ["README.md"],
      validation_performed: ["test"],
      review_verdict: "REVIEW_PASS",
      residual_risks: [],
    });

    // Mock runner for git operations: use real runner for git, but muse is mocked, so git will run real but with fake repo
    // The second call should be detected as duplicate before muse, so we can use same mock

    await handleAgentSessionCreated(ctx1, mockTokenManager(), {
      dataDir: dir,
      runner: runCommand,
      createActivity: mockCreateActivity,
      chatRunner: async () => ({ mode: "fetch", reply: "" }),
      museRunner: mockMuse,
      fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ html_url: "https://github.com/rohan-ahire1/scoutline/pull/1" }) }),
    });

    const store = new JobStore(dir);
    const jobAfterFirst = store.load("dup-sess-1");
    assert.ok(jobAfterFirst, "first job should exist");
    // First job may be completed or running depending on git push, but we check it was created
    assert.ok(["completed", "running", "failed", "awaiting_input"].includes(jobAfterFirst.status));

    activities = [];
    // Second delivery same session
    await handleAgentSessionCreated(ctx1, mockTokenManager(), {
      dataDir: dir,
      runner: runCommand,
      createActivity: mockCreateActivity,
      chatRunner: async () => ({ mode: "fetch", reply: "" }),
      museRunner: mockMuse,
    });

    // Should have posted duplicate thought, not started duplicate work
    assert.ok(activities.some((a) => a.content.body?.includes("already") || a.content.body?.includes("previously") || a.content.body?.includes("queued") || a.content.body?.includes("received")));
    const jobAfterSecond = store.load("dup-sess-1");
    assert.equal(jobAfterSecond.sessionId, "dup-sess-1");
    // Status should not have been reset to created; remains same or not duplicated
    assert.equal(jobAfterSecond.status, jobAfterFirst.status);
  });

  it("no repo matched runs scratch workspace and answers directly", async () => {
    const mockMuse = async () => ({
      status: "completed",
      summary: "two-line ticket summary",
      questions: [],
      changed_files: [],
      validation_performed: [],
      residual_risks: [],
    });
    const gitMustNotRun = async () => { throw new Error("scratch must not run git"); };
    const ctx = {
      agentSessionId: "ambig-1",
      initialPrompt: "do something generic",
      issueIdentifier: "UNKNOWN-1",
      issueTitle: "ambiguous no repo keyword",
      promptContext: "do something generic",
      rawPayload: {},
    };
    await handleAgentSessionCreated(ctx, mockTokenManager(), {
      dataDir: dir,
      runner: gitMustNotRun,
      createActivity: mockCreateActivity,
      chatRunner: async () => ({ mode: "fetch", reply: "" }),
      museRunner: mockMuse,
    });
    const store = new JobStore(dir);
    const job = store.load("ambig-1");
    assert.equal(job.status, "completed");
    assert.equal(job.workspaceKind, "scratch");
    assert.ok(job.summary.includes("two-line"));
    assert.ok(activities.some((a) => a.content.type === "response" && a.content.body.includes("two-line")));
    assert.ok(!activities.some((a) => a.content.type === "elicitation"));
  });

  it("a greeting is answered conversationally in scratch without git", async () => {
    const gitMustNotRun = async () => {
      throw new Error("a greeting must not create a worktree or run git");
    };
    const ctx = {
      agentSessionId: "hello-1",
      issueIdentifier: "ROH-15",
      issueTitle: "scoutline implementation task",
      // This mirrors Linear's full issue context: it can name a repo and
      // contain imperative text, but it is not the current user message.
      promptContext: "<issue>implement the scoutline ticket</issue>",
      initialPrompt: "hey @ghost you there",
      rawPayload: {},
    };

    await handleAgentSessionCreated(ctx, mockTokenManager(), {
      dataDir: dir,
      runner: gitMustNotRun,
      createActivity: mockCreateActivity,
      chatRunner: async () => ({ mode: "fetch", reply: "" }),
      museRunner: async () => ({
        status: "completed",
        summary: "Hey! Tell me what to work on.",
        questions: [],
        changed_files: [],
        validation_performed: [],
        residual_risks: [],
      }),
    });

    const job = new JobStore(dir).load("hello-1");
    assert.equal(job.status, "completed");
    assert.equal(job.workspaceKind, "scratch");
    assert.equal(job.repo, undefined);
    assert.ok(activities.some((a) => a.content.type === "response" && a.content.body.includes("Tell me what to work on")));
    assert.ok(!activities.some((a) => a.content.body?.includes("Setting up isolated worktree")));
  });

  it("created without user text asks for the task without running anything", async () => {
    const mustNotRun = async () => {
      throw new Error("no instruction means no pipeline");
    };
    const ctx = {
      agentSessionId: "no-text-1",
      issueIdentifier: "ROH-15",
      issueTitle: "scoutline implementation task",
      promptContext: "<issue>implement the scoutline ticket</issue>",
      rawPayload: {},
    };

    await handleAgentSessionCreated(ctx, mockTokenManager(), {
      dataDir: dir,
      runner: mustNotRun,
      createActivity: mockCreateActivity,
      chatRunner: mustNotRun,
      museRunner: mustNotRun,
    });

    const job = new JobStore(dir).load("no-text-1");
    assert.equal(job.status, "awaiting_input");
    assert.equal(job.interactionMode, "conversation");
    assert.equal(job.repo, undefined);
    assert.ok(activities.some((a) => a.content.type === "elicitation"));
  });

  it("a short question with full issue context answers in scratch without git", async () => {
    const gitMustNotRun = async () => {
      throw new Error("a question must not create a worktree or run git");
    };
    const ctx = {
      agentSessionId: "question-1",
      issueIdentifier: "ROH-15",
      issueTitle: "scoutline implementation task",
      // Full issue history names a repo, but the actual message is a question.
      promptContext: "<issue>implement the scoutline ticket</issue>",
      initialPrompt: "hey @ghost can you read this whats 2+2",
      rawPayload: {},
    };
    let musePrompt = "";
    await handleAgentSessionCreated(ctx, mockTokenManager(), {
      dataDir: dir,
      runner: gitMustNotRun,
      createActivity: mockCreateActivity,
      chatRunner: async () => ({ mode: "fetch", reply: "" }),
      museRunner: async ({ prompt }) => {
        musePrompt = prompt;
        return {
          status: "completed",
          summary: "2 + 2 = 4.",
          questions: [],
          changed_files: [],
          validation_performed: [],
          residual_risks: [],
        };
      },
    });

    const job = new JobStore(dir).load("question-1");
    assert.equal(job.status, "completed");
    assert.equal(job.workspaceKind, "scratch");
    assert.ok(musePrompt.includes("whats 2+2"), "directive should lead the prompt");
    assert.ok(activities.some((a) => a.content.type === "response" && a.content.body.includes("2 + 2")));
    assert.ok(!activities.some((a) => a.content.body?.includes("Setting up isolated worktree")));
  });

  it("multiple repos still reaches Muse and can return an elicitation", async () => {
    const ctx = {
      agentSessionId: "multi-1",
      initialPrompt: "work on scoutline and flaggo",
      issueTitle: "scoutline and flaggo",
      promptContext: "both",
      rawPayload: {},
    };
    await handleAgentSessionCreated(ctx, mockTokenManager(), {
      dataDir: dir,
      createActivity: mockCreateActivity,
      chatRunner: async () => ({ mode: "fetch", reply: "" }),
      museRunner: async () => ({
        status: "blocked",
        summary: "Choose a repository",
        questions: ["Which repository should I change?"],
        changed_files: [],
        validation_performed: [],
        residual_risks: [],
      }),
    });
    const store = new JobStore(dir);
    const job = store.load("multi-1");
    assert.equal(job.status, "awaiting_input");
    assert.equal(job.workspaceKind, "scratch");
    assert.ok(activities.some((a) => a.content.type === "elicitation" && a.content.body.includes("Which repository")));
  });

  it("prompted with awaiting_input appends follow-up and resumes", async () => {
    // Setup job with awaiting_input
    const store = new JobStore(dir);
    store.create({
      sessionId: "resume-1",
      status: "awaiting_input",
      issueIdentifier: "SCOUT-123",
      issueTitle: "scoutline test",
      promptContext: "original",
      followUps: [],
      repo: { id: "scoutline", path: "/tmp/fake", github: "rohan-ahire1/scoutline" },
      branch: "ghost/scout-123",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      summary: "blocked",
      questions: ["what?"],
    });

    const payload = {
      agentSession: { id: "resume-1" },
      agentActivity: { body: "clarification: use scoutline" },
    };

    // Mock resume to avoid real git: provide a museRunner that will be called if resume succeeds.
    // But our prompted handler for awaiting_input will try to run pipeline with repo path /tmp/fake which doesn't exist -> it will fail.
    // We can test the follow-up appending and status change to running before failure, without needing full success.

    // Patch jobStore path to use dir and mock runner to avoid git failure for this test, we set GHOST_REPO_SCOUTLINE_PATH to a fake git repo as before
    const fakeRepoPath = join(dir, "fake-scoutline2");
    mkdirSync(fakeRepoPath, { recursive: true });
    const { runCommand } = await import("../dist/commandRunner.js");
    await runCommand({ command: "git", args: ["init"], cwd: fakeRepoPath, timeoutMs: 5000 });
    await runCommand({ command: "git", args: ["config", "user.email", "ghost@test.com"], cwd: fakeRepoPath, timeoutMs: 2000 });
    await runCommand({ command: "git", args: ["config", "user.name", "Ghost"], cwd: fakeRepoPath, timeoutMs: 2000 });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(fakeRepoPath, "README.md"), "# test");
    await runCommand({ command: "git", args: ["add", "."], cwd: fakeRepoPath, timeoutMs: 2000 });
    await runCommand({ command: "git", args: ["commit", "-m", "init"], cwd: fakeRepoPath, timeoutMs: 2000 });
    await runCommand({ command: "git", args: ["branch", "-M", "main"], cwd: fakeRepoPath, timeoutMs: 2000 });
    const originPath = join(dir, "origin2.git");
    mkdirSync(originPath, { recursive: true });
    await runCommand({ command: "git", args: ["init", "--bare", originPath], timeoutMs: 5000 });
    await runCommand({ command: "git", args: ["remote", "add", "origin", originPath], cwd: fakeRepoPath, timeoutMs: 2000 });
    await runCommand({ command: "git", args: ["push", "-u", "origin", "main"], cwd: fakeRepoPath, timeoutMs: 5000 });
    process.env.GHOST_REPO_SCOUTLINE_PATH = fakeRepoPath;

    // Update job repo path to match fake
    const j = store.load("resume-1");
    j.repo.path = fakeRepoPath;
    store.save(j);

    const mockMuse = async () => ({
      status: "completed",
      summary: "resumed and completed",
      questions: [],
      changed_files: [],
      validation_performed: [],
      review_verdict: "REVIEW_PASS",
      residual_risks: [],
    });

    // Need to also handle that after resume, git diff will be empty -> will fail, but we care about follow-up appended
    // So we test the follow-up appending before pipeline failure
    await handleAgentSessionPrompted(payload, mockTokenManager(), {
      dataDir: dir,
      runner: runCommand,
      createActivity: mockCreateActivity,
      chatRunner: async () => ({ mode: "fetch", reply: "" }),
      museRunner: mockMuse,
    });

    const after = store.load("resume-1");
    assert.ok(after.followUps.length >= 1);
    assert.ok(after.followUps[0].includes("clarification"));
    // After resume, status may be completed or failed depending on git diff, but not awaiting_input
    assert.ok(["running", "completed", "failed"].includes(after.status));
    assert.ok(activities.some((a) => a.content.body?.includes("Reading")));
  });

  it("prompted when running queues follow-up without duplicating", async () => {
    const store = new JobStore(dir);
    store.create({
      sessionId: "running-1",
      status: "running",
      followUps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const payload = { agentSession: { id: "running-1" }, agentActivity: { body: "follow up while running" } };
    await handleAgentSessionPrompted(payload, mockTokenManager(), { dataDir: dir, createActivity: mockCreateActivity });
    const after = store.load("running-1");
    assert.equal(after.followUps.length, 1);
    assert.ok(activities.some((a) => a.content.body?.includes("still working") || a.content.body?.includes("queued")));
  });

  it("prompted on a completed job starts a new turn in the same chat", async () => {
    const store = new JobStore(dir);
    store.create({
      sessionId: "completed-1",
      status: "completed",
      branch: "ghost/scout-123",
      prUrl: "https://github.com/rohan-ahire1/scoutline/pull/1",
      followUps: [],
      summary: "done",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const payload = { agentSession: { id: "completed-1" }, agentActivity: { body: "thanks" } };
    await handleAgentSessionPrompted(payload, mockTokenManager(), {
      dataDir: dir,
      createActivity: mockCreateActivity,
      chatRunner: async () => ({ mode: "fetch", reply: "" }),
      museRunner: async () => ({
        status: "completed",
        summary: "you're welcome",
        questions: [],
        changed_files: [],
        validation_performed: [],
        residual_risks: [],
      }),
    });
    assert.ok(activities.some((a) => a.content.body?.includes("you're welcome")));
    assert.ok(!activities.some((a) => a.content.body?.includes("already completed")));
  });

  it("a message arriving mid-turn chains a second turn without resending history", async () => {
    const store = new JobStore(dir);
    store.create({
      sessionId: "chain-1",
      status: "awaiting_input",
      followUps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const prompts = [];
    let museCalls = 0;
    const chainingMuse = async ({ prompt }) => {
      museCalls++;
      prompts.push(prompt);
      if (museCalls === 1) {
        // Simulate a user message arriving while the first turn runs
        const rec = store.load("chain-1");
        rec.followUps.push("then do second thing");
        store.save(rec);
        return { status: "completed", summary: "first done", questions: [], changed_files: [], validation_performed: [], residual_risks: [] };
      }
      return { status: "completed", summary: "second done", questions: [], changed_files: [], validation_performed: [], residual_risks: [] };
    };

    await handleAgentSessionPrompted(
      { agentSession: { id: "chain-1" }, agentActivity: { body: "do first thing" } },
      mockTokenManager(),
      { dataDir: dir, createActivity: mockCreateActivity, chatRunner: async () => ({ mode: "fetch", reply: "" }), museRunner: chainingMuse },
    );

    assert.equal(museCalls, 2);
    assert.ok(prompts[0].includes("do first thing"));
    assert.ok(!prompts[0].includes("second thing"));
    assert.ok(prompts[1].includes("then do second thing"));
    assert.ok(!prompts[1].includes("do first thing"), "second turn must not resend consumed history");
    assert.ok(activities.some((a) => a.content.body?.includes("second done")));
  });

  it("chained turns stop at the cap with a notice instead of looping forever", async () => {
    const store = new JobStore(dir);
    store.create({
      sessionId: "chain-cap-1",
      status: "awaiting_input",
      followUps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    let museCalls = 0;
    const endlessMuse = async () => {
      museCalls++;
      // Every turn queues one more message, so pending never empties
      const rec = store.load("chain-cap-1");
      rec.followUps.push(`message ${museCalls}`);
      store.save(rec);
      return { status: "completed", summary: `turn ${museCalls} done`, questions: [], changed_files: [], validation_performed: [], residual_risks: [] };
    };

    await handleAgentSessionPrompted(
      { agentSession: { id: "chain-cap-1" }, agentActivity: { body: "start" } },
      mockTokenManager(),
      { dataDir: dir, createActivity: mockCreateActivity, chatRunner: async () => ({ mode: "fetch", reply: "" }), museRunner: endlessMuse },
    );

    assert.equal(museCalls, 10);
    assert.ok(activities.some((a) => a.content.body?.includes("Still have queued messages")));
  });

  it("progress lines from a turn are posted as thoughts", async () => {
    const store = new JobStore(dir);
    store.create({
      sessionId: "progress-1",
      status: "awaiting_input",
      followUps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    let captured = null;
    const toolLine = (kind) => JSON.stringify({ payload: { event: { kind, task_id: "t1", task_kind: "tool.bash" } } });

    await handleAgentSessionPrompted(
      { agentSession: { id: "progress-1" }, agentActivity: { body: "hi there" } },
      mockTokenManager(),
      {
        dataDir: dir,
        createActivity: mockCreateActivity,
        chatRunner: async () => ({ mode: "fetch", reply: "" }),
        museRunner: async (opts) => {
          captured = opts;
          opts.onProgressLine(toolLine("proposed"));
          opts.onProgressLine(toolLine("started"));
          opts.onProgressLine(toolLine("completed"));
          return { status: "completed", summary: "hey", questions: [], changed_files: [], validation_performed: [], residual_risks: [] };
        },
      },
    );

    assert.ok(captured && typeof captured.onProgressLine === "function");
    const thoughts = activities.filter((a) => a.content.type === "thought").map((a) => a.content.body);
    assert.ok(thoughts.some((b) => b === "▶ bash"), `expected a progress thought, got: ${JSON.stringify(thoughts)}`);
    void store;
  });

  it("scratch answers post bare with no task boilerplate", async () => {
    const ctx = {
      agentSessionId: "bare-1",
      issueIdentifier: "ROH-15",
      issueTitle: "Some big implementation ticket",
      promptContext: "large issue history",
      initialPrompt: "what is the square of 8",
      rawPayload: {},
    };

    await handleAgentSessionCreated(ctx, mockTokenManager(), {
      dataDir: dir,
      createActivity: mockCreateActivity,
      chatRunner: async () => ({ mode: "fetch", reply: "" }),
      museRunner: async () => ({
        status: "completed",
        summary: "64",
        questions: [],
        changed_files: [],
        validation_performed: [],
        residual_risks: [],
      }),
    });

    const responses = activities.filter((a) => a.content.type === "response");
    assert.equal(responses.length, 1);
    assert.equal(responses[0].content.body, "64");
  });

  it("prompt activity content wins over the stale creation mention", async () => {
    const store = new JobStore(dir);
    store.create({
      sessionId: "real-shape-1",
      status: "awaiting_input",
      followUps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    let musePrompt = null;
    // Real Linear prompted shape: agentActivity.content (type prompt) holds
    // the follow-up; agentSession.comment holds the stale "@ghost hi".
    const payload = {
      agentSession: { id: "real-shape-1", comment: { body: "@ghost hi" } },
      agentActivity: { id: "a1", content: { type: "prompt", body: "what is the square of 8" } },
    };

    await handleAgentSessionPrompted(payload, mockTokenManager(), {
      dataDir: dir,
      createActivity: mockCreateActivity,
      chatRunner: async () => ({ mode: "fetch", reply: "" }),
      museRunner: async ({ prompt }) => {
        musePrompt = prompt;
        return { status: "completed", summary: "64", questions: [], changed_files: [], validation_performed: [], residual_risks: [] };
      },
    });

    const after = store.load("real-shape-1");
    assert.ok(after.followUps.some((f) => f.includes("square of 8")));
    assert.ok(!after.followUps.some((f) => f.includes("@ghost hi")));
    assert.ok(musePrompt && musePrompt.includes("square of 8"));
    const responses = activities.filter((a) => a.content.type === "response");
    assert.equal(responses.length, 1);
    assert.equal(responses[0].content.body, "64");
  });

  it("echoes of our own activities are ignored, not answered", async () => {
    const store = new JobStore(dir);
    store.create({
      sessionId: "echo-1",
      status: "awaiting_input",
      followUps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    let museCalls = 0;

    await handleAgentSessionPrompted(
      {
        agentSession: { id: "echo-1", comment: { body: "@ghost hi" } },
        agentActivity: { id: "a2", content: { type: "thought", body: "Ghost is still working" } },
      },
      mockTokenManager(),
      {
        dataDir: dir,
        createActivity: mockCreateActivity,
        chatRunner: async () => ({ mode: "fetch", reply: "" }),
        museRunner: async () => { museCalls++; throw new Error("echo must not start a turn"); },
      },
    );

    assert.equal(museCalls, 0);
    assert.deepEqual(store.load("echo-1").followUps, []);
    assert.equal(activities.length, 0);
  });

  it("duplicate created with new text runs a turn when the job is idle", async () => {
    const store = new JobStore(dir);
    store.create({
      sessionId: "dup-text-1",
      status: "awaiting_input",
      followUps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await handleAgentSessionCreated(
      {
        agentSessionId: "dup-text-1",
        rawPayload: { comment: { body: "now do it" } },
      },
      mockTokenManager(),
      {
        dataDir: dir,
        createActivity: mockCreateActivity,
        chatRunner: async () => ({ mode: "fetch", reply: "" }),
        museRunner: async () => ({
          status: "completed",
          summary: "did it",
          questions: [],
          changed_files: [],
          validation_performed: [],
          residual_risks: [],
        }),
      },
    );

    assert.ok(store.load("dup-text-1").followUps.some((f) => f.includes("now do it")));
    assert.ok(activities.some((a) => a.content.body?.includes("did it")));
  });

  it("a follow-up question on a textless session reaches Muse in scratch", async () => {
    const store = new JobStore(dir);
    store.create({
      sessionId: "greeting-1",
      status: "awaiting_input",
      interactionMode: "conversation",
      issueIdentifier: "SCOUT-1",
      issueTitle: "An unrelated historical issue",
      promptContext: "large issue history that mentions scoutline",
      followUps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const gitMustNotRun = async () => { throw new Error("a question must not create a worktree or run git"); };

    await handleAgentSessionPrompted(
      { agentSession: { id: "greeting-1" }, agentActivity: { body: "what happened to this task" } },
      mockTokenManager(),
      {
        dataDir: dir,
        createActivity: mockCreateActivity,
        runner: gitMustNotRun,
        chatRunner: async () => ({ mode: "fetch", reply: "" }),
        museRunner: async () => ({
          status: "completed",
          summary: "Nothing has started yet — tell me the task.",
          questions: [],
          changed_files: [],
          validation_performed: [],
          residual_risks: [],
        }),
      },
    );

    const afterQuestion = store.load("greeting-1");
    assert.equal(afterQuestion.status, "completed");
    assert.equal(afterQuestion.repo, undefined);
    assert.equal(afterQuestion.branch, undefined);
    assert.ok(activities.some((a) => a.content.type === "response" && a.content.body.includes("Nothing has started yet")));
    assert.ok(!activities.some((a) => a.content.body?.includes("Setting up isolated worktree")));
  });

  it("a question on a previously completed session starts a fresh turn instead of replaying", async () => {
    const store = new JobStore(dir);
    store.create({
      sessionId: "old-greeting-1",
      status: "completed",
      followUps: [],
      summary: "Hey — I'm here. What's up?",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await handleAgentSessionPrompted(
      { agentSession: { id: "old-greeting-1" }, agentActivity: { body: "why" } },
      mockTokenManager(),
      {
        dataDir: dir,
        createActivity: mockCreateActivity,
        chatRunner: async () => ({ mode: "fetch", reply: "" }),
        museRunner: async () => ({
          status: "completed",
          summary: "Because nothing was asked yet.",
          questions: [],
          changed_files: [],
          validation_performed: [],
          residual_risks: [],
        }),
      },
    );

    assert.ok(["completed", "awaiting_input", "running"].includes(store.load("old-greeting-1").status));
    assert.ok(activities.some((a) => a.content.body?.includes("Because nothing was asked yet")));
    assert.ok(!activities.some((a) => a.content.body?.includes("already completed")));
  });

  it("a typo'd greeting is answered in scratch without git", async () => {
    const ctx = {
      agentSessionId: "greeting-typo-1",
      issueIdentifier: "SCOUT-1",
      issueTitle: "An unrelated historical issue",
      promptContext: "large issue history that mentions scoutline",
      initialPrompt: "@ghost waht up",
      rawPayload: {},
    };
    const gitMustNotRun = async () => { throw new Error("typo greeting must not create a worktree or run git"); };

    await handleAgentSessionCreated(ctx, mockTokenManager(), {
      dataDir: dir,
      createActivity: mockCreateActivity,
      runner: gitMustNotRun,
      chatRunner: async () => ({ mode: "fetch", reply: "" }),
      museRunner: async () => ({
        status: "completed",
        summary: "Hey! What do you want to work on?",
        questions: [],
        changed_files: [],
        validation_performed: [],
        residual_risks: [],
      }),
    });

    const store = new JobStore(dir);
    const after = store.load("greeting-typo-1");
    assert.equal(after.status, "completed");
    assert.equal(after.workspaceKind, "scratch");
    assert.equal(after.repo, undefined);
    assert.ok(activities.some((a) => a.content.type === "response"));
    assert.ok(!activities.some((a) => a.content.body?.includes("Setting up isolated worktree")));
  });

  it("prompted without user text is ignored instead of resuming work", async () => {
    const store = new JobStore(dir);
    store.create({
      sessionId: "empty-echo-1",
      status: "awaiting_input",
      interactionMode: "conversation",
      issueIdentifier: "SCOUT-123",
      issueTitle: "some issue",
      promptContext: "original issue context that mentions scoutline",
      followUps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const mustNotRun = async () => { throw new Error("empty prompted event must not resume a pipeline"); };

    // Linear echoes activities back as prompted events with no readable body
    await handleAgentSessionPrompted(
      { agentSession: { id: "empty-echo-1" }, agentActivity: {} },
      mockTokenManager(),
      { dataDir: dir, createActivity: mockCreateActivity, runner: mustNotRun, chatRunner: async () => ({ mode: "fetch", reply: "" }), museRunner: mustNotRun },
    );

    const after = store.load("empty-echo-1");
    assert.equal(after.status, "awaiting_input");
    assert.deepEqual(after.followUps, []);
    assert.equal(activities.length, 0);
  });

  it("prompted reads user text from comment-shaped payloads", async () => {
    const store = new JobStore(dir);
    store.create({
      sessionId: "comment-shape-1",
      status: "awaiting_input",
      interactionMode: "conversation",
      followUps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const gitMustNotRun = async () => { throw new Error("quick question must not create a worktree or run git"); };

    await handleAgentSessionPrompted(
      { agentSession: { id: "comment-shape-1" }, comment: { body: "waht up" } },
      mockTokenManager(),
      {
        dataDir: dir,
        createActivity: mockCreateActivity,
        runner: gitMustNotRun,
        chatRunner: async () => ({ mode: "fetch", reply: "" }),
        museRunner: async () => ({
          status: "completed",
          summary: "Hey there.",
          questions: [],
          changed_files: [],
          validation_performed: [],
          residual_risks: [],
        }),
      },
    );

    const after = store.load("comment-shape-1");
    assert.equal(after.status, "completed");
    assert.equal(after.repo, undefined);
    assert.ok(after.followUps.some((f) => f.includes("waht up")));
    assert.ok(activities.some((a) => a.content.type === "response" && a.content.body.includes("Hey there")));
  });

  it("extractGhostContext defensive", () => {
    assert.equal(extractGhostContext({}), null);
    const ctx = extractGhostContext({ agentSession: { id: "sess-1" }, promptContext: "hello" });
    assert.equal(ctx.agentSessionId, "sess-1");
    const ctx2 = extractGhostContext({ data: { id: "sess-2" } });
    assert.equal(ctx2.agentSessionId, "sess-2");
    const ctx3 = extractGhostContext({
      agentSession: { id: "sess-3", comment: { body: "hey @ghost" } },
      promptContext: "full ticket history",
    });
    assert.equal(ctx3.initialPrompt, "hey @ghost");
  });
});
