import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";

// Helpers
function delay(ms){ return new Promise(r=>setTimeout(r,ms)); }

// Capture console
function captureConsole(){
  const logs=[];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const capture = (...args)=>{
    const line = args.map(a=> typeof a==="string"?a: JSON.stringify(a)).join(" ");
    logs.push(line);
  };
  console.log = (...a)=>{ capture(...a); };
  console.warn = (...a)=>{ capture(...a); };
  console.error = (...a)=>{ capture(...a); };
  return {
    logs,
    restore(){
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    },
    origLog, origWarn, origError
  };
}

describe("Muse regression: GitHub arbitrary-token redaction", ()=>{
  let origEnv;
  beforeEach(()=>{ origEnv={...process.env}; });
  afterEach(()=>{
    for(const k of Object.keys(process.env)) if(!(k in origEnv)) delete process.env[k];
    for(const [k,v] of Object.entries(origEnv)) process.env[k]=v;
  });

  it("fetch exception with arbitrary token never appears in console.warn/error", async ()=>{
    const { createPullRequest } = await import("../dist/github.js");
    const opaque = "totally-secret-opaque-value-927";
    const cap = captureConsole();
    try{
      const mockFetch = async ()=>{ throw new Error(`network fail with ${opaque} inside`); };
      const res = await createPullRequest({
        token: opaque,
        ownerRepo: "rohan-ahire1/scoutline",
        branch: "ghost/test-branch",
        title:"T", body:"B"
      }, mockFetch);
      // Should fallback to compareUrl
      assert.ok(res.compareUrl);
      const combined = cap.logs.join("\n");
      assert.ok(!combined.includes(opaque), `logs leaked opaque token: ${combined.slice(0,1200)}`);
      // Ensure at least one log captured (list or create error)
      assert.ok(cap.logs.length>0);
      // Ensure redacted marker present or at least token absent
      for(const line of cap.logs){
        assert.ok(!line.includes(opaque));
      }
    } finally{ cap.restore(); }
  });

  it("non-OK response body with arbitrary token is redacted in console.error", async ()=>{
    const { createPullRequest } = await import("../dist/github.js");
    const opaque = "totally-secret-opaque-value-927";
    const cap = captureConsole();
    try{
      const mockFetch = async (url, opts)=>{
        if(url.includes("/pulls?head=")){
          return { ok:true, status:200, text: async()=> JSON.stringify([]) };
        }
        if(url.endsWith("/pulls")){
          return { ok:false, status:500, text: async()=> `server error body contains ${opaque} and more` };
        }
        throw new Error("unexpected");
      };
      const res = await createPullRequest({
        token: opaque,
        ownerRepo: "rohan-ahire1/scoutline",
        branch: "ghost/test-branch",
        title:"T", body:"B"
      }, mockFetch);
      assert.ok(res.compareUrl);
      assert.equal(res.prUrl, undefined);
      const combined = cap.logs.join("\n");
      assert.ok(!combined.includes(opaque), `logs leaked token via body: ${combined}`);
      // Should have redacted marker
      const hasRedacted = cap.logs.some(l=> l.includes("[redacted]"));
      assert.ok(hasRedacted, "expected [redacted] in logs");
    } finally{ cap.restore(); }
  });

  it("list exception and create body both containing token are redacted", async ()=>{
    const { createPullRequest } = await import("../dist/github.js");
    const opaque = "totally-secret-opaque-value-927";
    const cap = captureConsole();
    try{
      // First call list throws with token, second path create also would contain token but we throw first
      let call=0;
      const mockFetch = async (url)=>{
        call++;
        if(call===1){
          throw new Error(`list boom ${opaque}`);
        }
        // create path
        return { ok:false, status:500, text: async()=> `create body ${opaque}` };
      };
      const res = await createPullRequest({
        token: opaque,
        ownerRepo: "rohan-ahire1/scoutline",
        branch: "ghost/x",
        title:"T", body:"B"
      }, mockFetch);
      assert.ok(res.compareUrl);
      const combined = cap.logs.join("\n");
      assert.ok(!combined.includes(opaque));
    } finally{ cap.restore(); }
  });

  it("preserves/restores console and env safely", async ()=>{
    const origWarn = console.warn;
    const origError = console.error;
    const opaque="totally-secret-opaque-value-927";
    const cap=captureConsole();
    cap.restore();
    assert.equal(console.warn, origWarn);
    assert.equal(console.error, origError);
    // env
    process.env.TEST_OPAQUE=opaque;
    const { createPullRequest } = await import("../dist/github.js");
    const c2=captureConsole();
    try{
      const mockFetch= async()=> { throw new Error(`fail ${opaque}`);}
      await createPullRequest({token:opaque, ownerRepo:"rohan-ahire1/scoutline", branch:"ghost/y", title:"T", body:"B"}, mockFetch);
      assert.ok(!c2.logs.join("\n").includes(opaque));
    } finally{ c2.restore(); delete process.env.TEST_OPAQUE; }
  });
});

describe("Muse regression: Unicode byte cap", ()=>{
  it("stdout multibyte is capped by UTF-8 bytes, truncated true", async ()=>{
    const { runCommand } = await import("../dist/commandRunner.js");
    const maxOutputBytes = 50;
    // Each 😀 is 4 bytes. 100 emojis = 400 bytes, 200 chars (surrogate length 2 each => 200). With cap 50 bytes, if capped by chars (50 chars => 25 emojis => 100 bytes), would exceed byte cap.
    const res = await runCommand({
      command: "node",
      args: ["-e", "process.stdout.write('😀'.repeat(100))"],
      timeoutMs: 3000,
      maxOutputBytes,
    });
    assert.equal(res.truncated, true);
    const byteLen = Buffer.byteLength(res.stdout, "utf8");
    assert.ok(byteLen <= maxOutputBytes, `byteLen ${byteLen} > ${maxOutputBytes}`);
    // Also ensure char count would be misleading: 50 chars would be 100 bytes, so byteLen must be <=50, proving byte cap
    assert.ok(byteLen === maxOutputBytes || byteLen <= maxOutputBytes);
    // Also stdout should contain at least one emoji (maybe truncated in middle yields replacement, but still)
    assert.ok(res.stdout.length > 0);
  });

  it("stderr multibyte is capped by UTF-8 bytes, truncated true", async ()=>{
    const { runCommand } = await import("../dist/commandRunner.js");
    const maxOutputBytes = 30;
    const res = await runCommand({
      command: "node",
      args: ["-e", "process.stderr.write('💣'.repeat(100))"], // bomb emoji 4 bytes
      timeoutMs: 3000,
      maxOutputBytes,
    });
    assert.equal(res.truncated, true);
    const byteLen = Buffer.byteLength(res.stderr, "utf8");
    assert.ok(byteLen <= maxOutputBytes, `stderr byteLen ${byteLen} > ${maxOutputBytes}`);
    // Ensure stderr truncated
    assert.ok(res.stderr.length>0);
  });

  it("mixed stdout and stderr both respect byte cap", async ()=>{
    const { runCommand } = await import("../dist/commandRunner.js");
    const res = await runCommand({
      command: "node",
      args: ["-e", "process.stdout.write('α'.repeat(500)); process.stderr.write('β'.repeat(500))"], // Greek alpha 2 bytes each
      timeoutMs: 3000,
      maxOutputBytes: 100,
    });
    assert.equal(res.truncated, true);
    assert.ok(Buffer.byteLength(res.stdout,"utf8") <= 100);
    assert.ok(Buffer.byteLength(res.stderr,"utf8") <= 100);
  });

  it("ascii still capped and exact boundary", async ()=>{
    const { runCommand } = await import("../dist/commandRunner.js");
    const res = await runCommand({
      command: "node",
      args: ["-e", "process.stdout.write('a'.repeat(200))"],
      timeoutMs: 2000,
      maxOutputBytes: 10,
    });
    assert.equal(res.truncated, true);
    assert.equal(Buffer.byteLength(res.stdout,"utf8"), 10);
  });
});

describe("Muse regression: cross-instance locking", ()=>{
  let dir;
  beforeEach(()=>{ dir = mkdtempSync(join(tmpdir(),"ghost-lock-")); });
  afterEach(()=>{ try{ rmSync(dir,{recursive:true, force:true});}catch{} });

  it("two distinct JobStore instances serialize same session", async ()=>{
    const { JobStore } = await import("../dist/jobStore.js");
    const storeA = new JobStore(dir);
    const storeB = new JobStore(dir);
    const order=[];
    const p1 = storeA.withSessionLock("sess-shared", async ()=>{
      order.push("A start");
      await delay(40);
      order.push("A end");
      return 1;
    });
    const p2 = storeB.withSessionLock("sess-shared", async ()=>{
      order.push("B start");
      order.push("B end");
      return 2;
    });
    const [r1,r2]= await Promise.all([p1,p2]);
    assert.equal(r1,1); assert.equal(r2,2);
    assert.deepEqual(order, ["A start","A end","B start","B end"], `order was ${JSON.stringify(order)}`);
    // Cleanup
    storeA.clearLocks(); storeB.clearLocks();
  });

  it("two distinct instances serialize same repo", async ()=>{
    const { JobStore } = await import("../dist/jobStore.js");
    const storeA = new JobStore(dir);
    const storeB = new JobStore(dir);
    const order=[];
    const p1 = storeA.withRepoLock("scoutline", async ()=>{
      order.push("A start");
      await delay(40);
      order.push("A end");
    });
    const p2 = storeB.withRepoLock("scoutline", async ()=>{
      order.push("B start");
      order.push("B end");
    });
    const p3 = storeA.withRepoLock("flaggo", async ()=>{
      order.push("C flaggo start");
      order.push("C flaggo end");
    });
    await Promise.all([p1,p2,p3]);
    assert.ok(order.indexOf("A start") < order.indexOf("A end"));
    assert.ok(order.indexOf("A end") < order.indexOf("B start"), `order ${JSON.stringify(order)} not serialized`);
    // flaggo can run concurrently, but at least completes
    assert.ok(order.includes("C flaggo start"));
    storeA.clearLocks(); storeB.clearLocks();
  });

  it("unrelated session keys proceed independently", async ()=>{
    const { JobStore } = await import("../dist/jobStore.js");
    const storeA = new JobStore(dir);
    const storeB = new JobStore(dir);
    const order=[];
    const pA = storeA.withSessionLock("sess-A", async ()=>{
      order.push("A start");
      await delay(30);
      order.push("A end");
    });
    const pB = storeB.withSessionLock("sess-B", async ()=>{
      // Should start before A ends if independent
      await delay(5);
      order.push("B start");
      order.push("B end");
    });
    await Promise.all([pA,pB]);
    // B start should be before A end if concurrent
    assert.ok(order.indexOf("B start") < order.indexOf("A end"), `expected concurrent but order ${JSON.stringify(order)}`);
    storeA.clearLocks(); storeB.clearLocks();
  });

  it("unrelated repo keys proceed independently where practical", async ()=>{
    const { JobStore } = await import("../dist/jobStore.js");
    const storeA = new JobStore(dir);
    const storeB = new JobStore(dir);
    const order=[];
    const p1 = storeA.withRepoLock("repo-1", async ()=>{
      order.push("R1 start");
      await delay(30);
      order.push("R1 end");
    });
    const p2 = storeB.withRepoLock("repo-2", async ()=>{
      await delay(5);
      order.push("R2 start");
      order.push("R2 end");
    });
    await Promise.all([p1,p2]);
    assert.ok(order.indexOf("R2 start") < order.indexOf("R1 end"), `expected independent but order ${JSON.stringify(order)}`);
    storeA.clearLocks(); storeB.clearLocks();
  });
});

describe("Muse regression: Full lifecycle no-repo clarification", ()=>{
  let dir, activities, mockCreateActivity;
  beforeEach(()=>{
    dir = mkdtempSync(join(tmpdir(),"ghost-no-repo-"));
    activities=[];
    mockCreateActivity = async ({accessToken, agentSessionId, content})=>{
      activities.push({agentSessionId, content});
      return true;
    };
    process.env.GHOST_DATA_DIR = dir;
    mkdirSync(join(dir,"worktrees"),{recursive:true});
  });
  afterEach(()=>{
    try{ rmSync(dir,{recursive:true, force:true});}catch{}
    delete process.env.GHOST_DATA_DIR;
    delete process.env.GHOST_REPO_SCOUTLINE_PATH;
    delete process.env.GHOST_REPO_FLAGGO_PATH;
  });

  it("no-repo request reaches Muse; a blocked answer can be resumed with a repo", async ()=>{
    const { handleAgentSessionCreated, handleAgentSessionPrompted } = await import("../dist/agentSession.js");
    const { JobStore } = await import("../dist/jobStore.js");
    function mockTokenManager(){ return { getValidAccessToken: async()=>"fake-token", getAuthHeader: async()=> "Bearer fake-token"}; }

    const ctx = {
      agentSessionId: "no-repo-sess-1",
      initialPrompt: "do something generic with no repo hint",
      issueIdentifier: "UNKNOWN-999",
      issueTitle: "generic task without repo keyword",
      promptContext: "do something generic with no repo hint",
      rawPayload: {}
    };
    let museCalls=0;
    const blockedMuse = async ()=>{
      museCalls++;
      return {
        status:"blocked",
        summary:"A repository is required",
        questions:["Which repository should I use?"],
        changed_files:[],
        validation_performed:[],
        residual_risks:[]
      };
    };
    await handleAgentSessionCreated(ctx, mockTokenManager(), { dataDir:dir, createActivity: mockCreateActivity, chatRunner: async () => ({ mode: "fetch", reply: "" }), museRunner: blockedMuse });

    const store = new JobStore(dir);
    const job = store.load("no-repo-sess-1");
    assert.ok(job, "job should persist");
    assert.equal(job.status, "awaiting_input");
    assert.equal(job.workspaceKind, "scratch");
    assert.equal(museCalls, 1);
    assert.ok(job.questions && job.questions.length>0);
    const elic = activities.find(a=> a.content.type==="elicitation");
    assert.ok(elic, "should have sent elicitation");
    // Ensure elicitation body mentions repo options
    assert.ok(elic.content.body.includes("Which repository"));

    // Now prompted follow-up saying use scoutline must resolve and invoke pipeline once, mocks only
    activities = [];
    const mockMuse = async ()=>{
      museCalls++;
      return {
        status:"completed",
        summary:"mocked fix done",
        questions:[],
        changed_files:["README.md"],
        validation_performed:["test"],
        residual_risks:[],
        wants_work:true,
      };
    };
    // Mock runner that simulates git pipeline without real git/network
    const mockRunner = async (opts)=>{
      const args = opts.args || [];
      const cmd = opts.command;
      if(cmd==="git"){
        if(args[0]==="fetch") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="ls-remote") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="worktree" && args[1]==="add") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="rev-parse" && args[1]==="--is-inside-work-tree") return {stdout:"true", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="rev-parse" && args[1]==="--abbrev-ref") return {stdout: opts.cwd?.includes("ghost")? "ghost/unknown-999" : "main", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="config" && args[1]==="--get") return {stdout:"https://github.com/rohan-ahire1/scoutline.git", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="status" && args[1]==="--porcelain") return {stdout:" M README.md\n", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="add") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="commit") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="rev-parse" && args[1]==="HEAD") return {stdout:"abc123def456abc123def456abc123def456abcd", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="push") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="branch" && args[1]==="--list") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
        // default success
        return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
      }
      if(cmd==="npm"){
        return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
      }
      return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
    };
    const mockFetch = async (url)=> {
      // For PR creation after pipeline, return success
      if(url.includes("/pulls")){
        return { ok:true, status:201, text: async()=> JSON.stringify({html_url:"https://github.com/rohan-ahire1/scoutline/pull/1"}) };
      }
      return { ok:true, status:200, text: async()=> "[]" };
    };

    const payload = {
      agentSession: { id: "no-repo-sess-1" },
      agentActivity: { body: "use scoutline please" }
    };
    await handleAgentSessionPrompted(payload, mockTokenManager(), { dataDir:dir, runner: mockRunner, createActivity: mockCreateActivity, chatRunner: async () => ({ mode: "fetch", reply: "" }), museRunner: mockMuse, fetchFn: mockFetch });

    const after = store.load("no-repo-sess-1");
    assert.ok(after, "job should still exist");
    assert.ok(after.repo, "repo should be persisted after follow-up");
    assert.equal(after.repo.id, "scoutline");
    assert.ok(after.branch?.startsWith("ghost/"), `branch ${after.branch}`);
    assert.equal(museCalls, 3, `blocked turn + ticket decision + work execution, got ${museCalls}`);
    // Ensure status is not awaiting_input anymore (running/completed/failed) — but after mocked pipeline with successful muse and push, should be completed
    assert.ok(["running","completed","failed"].includes(after.status), `status ${after.status} unexpected`);
    assert.equal(after.status, "completed");
    // Ensure followUps persisted
    assert.ok(after.followUps.some(f=> f.includes("scoutline")));
  });
});

describe("Muse regression: Full lifecycle multi-repo clarification", ()=>{
  let dir, activities, mockCreateActivity;
  beforeEach(()=>{
    dir = mkdtempSync(join(tmpdir(),"ghost-multi-"));
    activities=[];
    mockCreateActivity = async ({accessToken, agentSessionId, content})=>{
      activities.push({agentSessionId, content});
      return true;
    };
    process.env.GHOST_DATA_DIR=dir;
    mkdirSync(join(dir,"worktrees"),{recursive:true});
  });
  afterEach(()=>{
    try{ rmSync(dir,{recursive:true, force:true});}catch{}
    delete process.env.GHOST_DATA_DIR;
  });

  it("multi-repo request reaches Muse; a blocked answer can be clarified once", async ()=>{
    const { handleAgentSessionCreated, handleAgentSessionPrompted } = await import("../dist/agentSession.js");
    const { JobStore } = await import("../dist/jobStore.js");
    function mockTokenManager(){ return { getValidAccessToken: async()=>"fake-token", getAuthHeader: async()=> "Bearer fake-token"}; }

    const ctx = {
      agentSessionId: "multi-clarify-1",
      initialPrompt: "do work for both scoutline and flaggo",
      issueIdentifier: "M-1",
      issueTitle: "scoutline and flaggo integration needed",
      promptContext: "do work for both scoutline and flaggo",
      rawPayload: {}
    };
    let museCalls=0;
    await handleAgentSessionCreated(ctx, mockTokenManager(), {
      dataDir:dir,
      createActivity: mockCreateActivity,
      chatRunner: async () => ({ mode: "fetch", reply: "" }),
      museRunner: async () => {
        museCalls++;
        return {
          status:"blocked",
          summary:"Choose one repository",
          questions:["Which repository should I change?"],
          changed_files:[],
          validation_performed:[],
          residual_risks:[]
        };
      }
    });
    const store = new JobStore(dir);
    let job = store.load("multi-clarify-1");
    assert.ok(job);
    assert.equal(job.status, "awaiting_input");
    assert.equal(job.workspaceKind, "scratch");
    assert.equal(museCalls, 1);
    const elic = activities.find(a=> a.content.type==="elicitation");
    assert.ok(elic);
    assert.ok(elic.content.body.includes("Which repository"));

    // Now follow-up selecting exactly one: "use flaggo only"
    activities=[];
    const mockMuse = async ()=>{
      museCalls++;
      // Simulate that muse makes a change, to ensure pipeline completes
      return {
        status:"completed",
        summary:"flaggo fix done",
        questions:[],
        changed_files:["src/index.ts"],
        validation_performed:[],
        residual_risks:[],
        wants_work:true,
      };
    };
    const mockRunner = async (opts)=>{
      const args=opts.args||[];
      if(opts.command==="git"){
        if(args[0]==="fetch") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="ls-remote") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="worktree" && args[1]==="add") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="status" && args[1]==="--porcelain") return {stdout:" M src/index.ts\n", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="add") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="commit") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="rev-parse" && args[1]==="HEAD") return {stdout:"deadbeef123456deadbeef123456deadbeef1234", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="push") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="branch" && args[1]==="--list") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(args[0]==="config") return {stdout:"https://github.com/rohan-ahire1/flaggo.git", stderr:"", exitCode:0, timedOut:false, truncated:false};
        return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
      }
      if(opts.command==="npm") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
      return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
    };
    const mockFetch = async (url)=>{
      if(url.includes("/pulls")) return { ok:true, status:201, text: async()=> JSON.stringify({html_url:"https://github.com/rohan-ahire1/flaggo/pull/2"}) };
      return { ok:true, status:200, text: async()=> "[]" };
    };
    const payload = {
      agentSession: { id: "multi-clarify-1"},
      agentActivity: { body: "use flaggo only" }
    };
    await handleAgentSessionPrompted(payload, mockTokenManager(), { dataDir:dir, runner: mockRunner, createActivity: mockCreateActivity, chatRunner: async () => ({ mode: "fetch", reply: "" }), museRunner: mockMuse, fetchFn: mockFetch });

    job = store.load("multi-clarify-1");
    assert.ok(job.repo, "repo should be set after clarification");
    assert.equal(job.repo.id, "flaggo", `expected flaggo but got ${job.repo.id}`);
    assert.ok(job.branch?.startsWith("ghost/"));
    assert.equal(museCalls, 3, `blocked turn + ticket decision + work execution, got ${museCalls}`);
    // Without duplicate execution: ensure not called twice and job status is completed (not awaiting_input)
    assert.equal(job.status, "completed");
    assert.ok(job.followUps.some(f=> f.includes("flaggo")));
    // A further message on the completed job starts a new turn in the same
    // chat; smalltalk stays in scratch and creates no worktree.
    const callsBefore = museCalls;
    activities=[];
    const payload2 = { agentSession:{id:"multi-clarify-1"}, agentActivity:{body:"another follow up"} };
    await handleAgentSessionPrompted(payload2, mockTokenManager(), { dataDir:dir, runner: mockRunner, createActivity: mockCreateActivity, chatRunner: async () => ({ mode: "fetch", reply: "" }), museRunner: mockMuse, fetchFn: mockFetch });
    assert.equal(museCalls, callsBefore + 1, "completed job plus new text runs one more turn");
    assert.ok(!activities.some(a=> a.content.body?.includes("already completed")));
    assert.ok(!activities.some(a=> a.content.body?.includes("Setting up isolated worktree")), "smalltalk must not create a worktree");
  });
});

describe("Muse regression: Worktree hardening", ()=>{
  let baseDir;
  beforeEach(()=>{ baseDir = mkdtempSync(join(tmpdir(),"ghost-worktree-")); });
  afterEach(()=>{ try{ rmSync(baseDir,{recursive:true, force:true});}catch{} delete process.env.GHOST_REPO_SCOUTLINE_PATH; });

  it("fetch timeout fails", async ()=>{
    const { ensureWorktree } = await import("../dist/gitPipeline.js");
    const target = join(baseDir,"target");
    mkdirSync(target,{recursive:true});
    const worktreeBase = join(baseDir,"worktrees");
    const mockRunner = async (opts)=>{
      if(opts.command==="git" && opts.args[0]==="fetch"){
        return {stdout:"", stderr:"", exitCode:null, timedOut:true, truncated:false};
      }
      return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
    };
    await assert.rejects(
      ()=> ensureWorktree({ targetRepoPath: target, worktreeBaseDir: worktreeBase, branch:"ghost/test-fetch-timeout", sessionId:"sess-1", dataDir: baseDir, runner: mockRunner }),
      /fetch timed out|timed out/i
    );
  });

  it("ls-remote timeout fails", async ()=>{
    const { ensureWorktree } = await import("../dist/gitPipeline.js");
    const target = join(baseDir,"target2");
    mkdirSync(target,{recursive:true});
    const worktreeBase = join(baseDir,"worktrees2");
    const mockRunner = async (opts)=>{
      if(opts.command==="git" && opts.args[0]==="fetch"){
        return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
      }
      if(opts.command==="git" && opts.args[0]==="ls-remote"){
        return {stdout:"", stderr:"", exitCode:null, timedOut:true, truncated:false};
      }
      return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
    };
    await assert.rejects(
      ()=> ensureWorktree({ targetRepoPath: target, worktreeBaseDir: worktreeBase, branch:"ghost/test-ls-timeout", sessionId:"sess-2", dataDir:baseDir, runner: mockRunner }),
      /ls-remote timed out/i
    );
  });

  it("ls-remote nonzero fails", async ()=>{
    const { ensureWorktree } = await import("../dist/gitPipeline.js");
    const target = join(baseDir,"target3");
    mkdirSync(target,{recursive:true});
    const worktreeBase = join(baseDir,"worktrees3");
    const mockRunner = async (opts)=>{
      if(opts.command==="git" && opts.args[0]==="fetch") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
      if(opts.command==="git" && opts.args[0]==="ls-remote") return {stdout:"", stderr:"error", exitCode:1, timedOut:false, truncated:false};
      return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
    };
    await assert.rejects(
      ()=> ensureWorktree({ targetRepoPath: target, worktreeBaseDir: worktreeBase, branch:"ghost/test-ls-nonzero", sessionId:"sess-3", dataDir:baseDir, runner: mockRunner }),
      /ls-remote failed/i
    );
  });

  it("existing directory with wrong branch fails", async ()=>{
    const { ensureWorktree } = await import("../dist/gitPipeline.js");
    const target = join(baseDir,"target4");
    mkdirSync(target,{recursive:true});
    const worktreeBase = join(baseDir,"worktrees4");
    mkdirSync(worktreeBase,{recursive:true});
    const branch = "ghost/expected-branch";
    const sessionId="sess-wrong-branch";
    const worktreePath = join(worktreeBase, sessionId);
    mkdirSync(worktreePath,{recursive:true});
    // Mock runner to simulate existing worktree is on wrong branch
    const mockRunner = async (opts)=>{
      const args=opts.args||[];
      if(opts.command==="git" && args[0]==="fetch") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
      if(opts.command==="git" && args[0]==="ls-remote") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
      if(opts.command==="git" && args[0]==="rev-parse" && args[1]==="--is-inside-work-tree") return {stdout:"true", stderr:"", exitCode:0, timedOut:false, truncated:false};
      if(opts.command==="git" && args[0]==="rev-parse" && args[1]==="--abbrev-ref") return {stdout:"ghost/wrong-branch", stderr:"", exitCode:0, timedOut:false, truncated:false};
      if(opts.command==="git" && args[0]==="config" && args[1]==="--get") return {stdout:"https://github.com/rohan-ahire1/scoutline.git", stderr:"", exitCode:0, timedOut:false, truncated:false};
      return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
    };
    await assert.rejects(
      ()=> ensureWorktree({ targetRepoPath: target, worktreeBaseDir: worktreeBase, branch, sessionId, dataDir:baseDir, runner: mockRunner }),
      /wrong branch|refusing to reuse/i
    );
  });

  it("existing directory with wrong origin fails", async ()=>{
    const { ensureWorktree } = await import("../dist/gitPipeline.js");
    const target = join(baseDir,"target5");
    mkdirSync(target,{recursive:true});
    const worktreeBase = join(baseDir,"worktrees5");
    mkdirSync(worktreeBase,{recursive:true});
    const branch = "ghost/correct-branch";
    const sessionId="sess-wrong-origin";
    const worktreePath = join(worktreeBase, sessionId);
    mkdirSync(worktreePath,{recursive:true});
    const mockRunner = async (opts)=>{
      const args=opts.args||[];
      if(opts.command==="git" && args[0]==="fetch") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
      if(opts.command==="git" && args[0]==="ls-remote") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
      if(opts.command==="git" && args[0]==="rev-parse" && args[1]==="--is-inside-work-tree") return {stdout:"true", stderr:"", exitCode:0, timedOut:false, truncated:false};
      if(opts.command==="git" && args[0]==="rev-parse" && args[1]==="--abbrev-ref") return {stdout:branch, stderr:"", exitCode:0, timedOut:false, truncated:false};
      if(opts.command==="git" && args[0]==="config" && args[1]==="--get"){
        // Distinguish target vs worktree: check cwd
        if(opts.cwd===worktreePath) return {stdout:"https://github.com/rohan-ahire1/flaggo.git", stderr:"", exitCode:0, timedOut:false, truncated:false};
        if(opts.cwd===target) return {stdout:"https://github.com/rohan-ahire1/scoutline.git", stderr:"", exitCode:0, timedOut:false, truncated:false};
        return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
      }
      return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
    };
    await assert.rejects(
      ()=> ensureWorktree({ targetRepoPath: target, worktreeBaseDir: worktreeBase, branch, sessionId, dataDir:baseDir, runner: mockRunner }),
      /remote mismatch|refusing to reuse/i
    );
  });

  it("uses mocked runner and temporary directories only (no network)", async ()=>{
    const { ensureWorktree } = await import("../dist/gitPipeline.js");
    const target = join(baseDir,"target6");
    mkdirSync(target,{recursive:true});
    const worktreeBase = join(baseDir,"worktrees6");
    // Ensure worktreeBase not yet exists, ensureWorktree should create base
    const mockRunner = async (opts)=>{
      if(opts.command==="git" && opts.args[0]==="fetch") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
      if(opts.command==="git" && opts.args[0]==="ls-remote") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
      if(opts.command==="git" && opts.args[0]==="worktree" && opts.args[1]==="add") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
      return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
    };
    const p = await ensureWorktree({ targetRepoPath: target, worktreeBaseDir: worktreeBase, branch:"ghost/new-branch", sessionId:"sess-ok", dataDir:baseDir, runner: mockRunner });
    assert.ok(p.includes("sess-ok"));
    assert.ok(existsSync(worktreeBase) || p.includes("worktrees6"));
  });

  it("prunes a session branch with no commits ahead of origin/main", async ()=>{
    const { pruneLocalBranchIfSafe } = await import("../dist/gitPipeline.js");
    const calls = [];
    const mockRunner = async (opts)=>{
      calls.push(opts.args.join(" "));
      const args = opts.args || [];
      if(args[0]==="rev-parse" && args[1]==="--verify") return {stdout:"abc123\n", stderr:"", exitCode:0, timedOut:false, truncated:false};
      if(args[0]==="rev-list") return {stdout:"0\n", stderr:"", exitCode:0, timedOut:false, truncated:false};
      if(args[0]==="branch" && args[1]==="-D") return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
      return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
    };
    const ok = await pruneLocalBranchIfSafe({ targetRepoPath: join(baseDir,"target"), branch:"ghost/roh-15-abcdef12", runner: mockRunner });
    assert.equal(ok, true);
    assert.ok(calls.some((c)=> c.includes("branch -D")));
  });

  it("keeps a session branch that has unique local commits", async ()=>{
    const { pruneLocalBranchIfSafe } = await import("../dist/gitPipeline.js");
    const calls = [];
    const mockRunner = async (opts)=>{
      calls.push(opts.args.join(" "));
      const args = opts.args || [];
      if(args.some((a)=> String(a).includes("origin/ghost/"))) return {stdout:"remote999\n", stderr:"", exitCode:0, timedOut:false, truncated:false};
      if(args[0]==="rev-parse") return {stdout:"abc123\n", stderr:"", exitCode:0, timedOut:false, truncated:false};
      if(args[0]==="rev-list") return {stdout:"3\n", stderr:"", exitCode:0, timedOut:false, truncated:false};
      return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false};
    };
    const ok = await pruneLocalBranchIfSafe({ targetRepoPath: join(baseDir,"target"), branch:"ghost/roh-15-abcdef12", runner: mockRunner });
    assert.equal(ok, false);
    assert.ok(!calls.some((c)=> c.includes("branch -D")));
  });

  it("refuses to prune branches outside ghost/", async ()=>{
    const { pruneLocalBranchIfSafe } = await import("../dist/gitPipeline.js");
    let called = false;
    const mockRunner = async ()=>{ called = true; return {stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false}; };
    assert.equal(await pruneLocalBranchIfSafe({ targetRepoPath: join(baseDir,"target"), branch:"main", runner: mockRunner }), false);
    assert.equal(called, false);
  });
});

describe("Muse regression: prompted-event logging", ()=>{
  let dir;
  beforeEach(()=>{
    dir = mkdtempSync(join(tmpdir(),"ghost-log-"));
    process.env.GHOST_DATA_DIR=dir;
    mkdirSync(join(dir,"worktrees"),{recursive:true});
  });
  afterEach(()=>{
    try{ rmSync(dir,{recursive:true, force:true});}catch{}
    delete process.env.GHOST_DATA_DIR;
  });

  it("prompted-event logging never contains follow-up body content", async ()=>{
    const { JobStore } = await import("../dist/jobStore.js");
    const { handleAgentSessionPrompted } = await import("../dist/agentSession.js");
    const store = new JobStore(dir);
    store.create({
      sessionId:"log-test-1",
      status:"awaiting_input",
      followUps:[],
      createdAt:new Date().toISOString(),
      updatedAt:new Date().toISOString(),
      summary:"awaiting",
      questions:["q1"]
    });
    const secretBody = "totally-secret-opaque-value-927-followup-body-SENSITIVE-XYZ";
    const cap = captureConsole();
    try{
      function mockTokenManager(){ return { getValidAccessToken: async()=>"fake-token", getAuthHeader: async()=> "Bearer fake-token"}; }
      const mockCreateActivity = async ()=> true;
      // Provide runner that will fail re-resolution? We need to ensure it doesn't crash before logging.
      // We set job to awaiting_input without repo, so prompted will try to re-resolve. secretBody contains no repo alias, so will remain awaiting_input and not invoke pipeline.
      // That still logs prompted event.
      const payload = {
        agentSession: { id:"log-test-1"},
        agentActivity: { body: secretBody }
      };
      // Need to provide deps that avoid throw: we set GHOST_DEFAULT_REPO? But secretBody has no repo, so re-resolution will give no repo and elicit again.
      // That is fine.
      await handleAgentSessionPrompted(payload, mockTokenManager(), { dataDir:dir, createActivity: mockCreateActivity, runner: async()=> ({stdout:"", stderr:"", exitCode:0, timedOut:false, truncated:false}) });
      const combined = cap.logs.join("\n");
      assert.ok(!combined.includes(secretBody), `logs leaked body: ${combined}`);
      assert.ok(!combined.includes("SENSITIVE-XYZ"), `logs leaked sensitive part`);
      // Should contain length or session metadata, not body
      const hasLength = cap.logs.some(l=> l.includes("bodyLength") || l.includes("bodyLength"));
      const hasSession = cap.logs.some(l=> l.includes("log-test-1"));
      assert.ok(hasLength || hasSession, `expected metadata logs but got ${JSON.stringify(cap.logs)}`);
      // Also ensure followUp not in activities body? But logging is about console, not activities; activities may contain elicitation but not raw body
      // Ensure no log line contains full secret
      for(const line of cap.logs){
        assert.ok(!line.includes(secretBody));
      }
    } finally{ cap.restore(); }
  });

  it("logging contains only length/session metadata, not content", async ()=>{
    const { handleAgentSessionPrompted } = await import("../dist/agentSession.js");
    const { JobStore } = await import("../dist/jobStore.js");
    const store = new JobStore(dir);
    store.create({
      sessionId:"log-test-2",
      status:"running",
      followUps:[],
      createdAt:new Date().toISOString(),
      updatedAt:new Date().toISOString(),
    });
    const body = "another totally-secret-opaque-value-927 content that must not leak";
    const cap = captureConsole();
    try{
      function mockTokenManager(){ return { getValidAccessToken: async()=>"fake-token", getAuthHeader: async()=> "Bearer fake-token"}; }
      await handleAgentSessionPrompted({ agentSession:{id:"log-test-2"}, agentActivity:{body} }, mockTokenManager(), { dataDir:dir, createActivity: async()=>true });
      const combined = cap.logs.join("\n");
      assert.ok(!combined.includes("totally-secret-opaque-value-927"));
      assert.ok(combined.includes("log-test-2") || combined.includes("AgentSession prompted"));
      // Ensure bodyLength logged
      assert.ok(combined.includes("bodyLength") || combined.includes(String(body.length)) || combined.includes("prompted"));
    } finally{ cap.restore(); }
  });
});
