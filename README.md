# Ghost — Linear Agent Service

Lightweight Node.js/TypeScript service that handles Linear webhooks and `AgentSessionEvent` for the Ghost agent. Auth is a single Linear personal API key (no OAuth). Ghost sends every request directly to Muse Code (`meta` / `muse-spark-1.3-contributor`) with a single invocation per request. Ghost owns worktree isolation, deterministic validation, commit/push, PR/compare-link publishing, persistence, and Linear status updates.

## Endpoints

| Route | Method | Description |
|-------|--------|-------------|
| `/health` | GET | `{status:"ok", service:"ghost"}` — no secrets |
| `/linear/webhook` | POST | Verifies `Linear-Signature` via HMAC-SHA256 timing-safe, checks `webhookTimestamp` (~60s), silently acks non-`AgentSessionEvent` noise, dedupes `Linear-Delivery`/`webhookId` (persisted), returns 200 immediately and dispatches background job |
| `/ops` | GET | Loopback-only: uptime, job counts by status, last failure, 20 most recent jobs |
| `/jobs` | GET | Loopback-only: all job summaries (no prompt bodies) |
| `/jobs/:id` | GET | Loopback-only: one job's detail (results + checks, no prompt bodies) |

## AgentSession Pipeline (Production)

`AgentSessionEvent action=created`:
1. Returns 200 immediately (no model/git work in HTTP path via `setImmediate`).
2. Logs safe metadata only (no prompt/token dump).
3. Validates Linear token, posts immediate `thought` ack (`👋 Ghost received…`).
4. The user's message is the instruction — the attached issue history is background, never orders. A session created with no user text stays open and asks what to do instead of dispatching the issue. Otherwise Ghost resolves a repository in priority order: exact Linear label match → `GHOST_PROJECT_MAP` (Linear project name/id → repo) → alias substring in title/prompt → `GHOST_DEFAULT_REPO` fallback. One match uses an isolated repo worktree; zero or multiple matches use private scratch so the request still reaches Muse. Muse asks for a repo only when the requested work actually requires one.
5. Persists durable job under `GHOST_DATA_DIR/jobs/<session>.json` (0700/0600, atomic writes) with states `created/running/awaiting_input/completed/failed`. Duplicate `created` deliveries (including after restart) are idempotent. Sessions on the same repo run concurrently in isolated worktrees; only short shared-checkout git setup/cleanup holds the per-repo lock.
6. If a repository resolved: fetches `origin/main` (without touching dirty checkout) and creates isolated worktree under `GHOST_DATA_DIR/worktrees/<session>` on a branch that includes both the sanitized issue identifier and session ID. This makes independent sessions on one ticket collision-free. Existing remote branch is refused unless it belongs to the same job. Never modifies or cleans the original checkout; never force-pushes. If no repository resolved — or the triggering message is a short question with no code-change request: creates a private per-session scratch workspace under `GHOST_DATA_DIR/scratch/<session>` (0700) — read/summary/general requests still work, and scratch never enters git/PR operations.
7. Runs one direct Muse invocation per substantive request via: `/home/rohan/.local/bin/muse exec --json --workspace <dir> --prompt-file <file> --provider meta --model muse-spark-1.3-contributor --reasoning-effort high --parallel-tool-calls --trust-workspace --no-foreign-personal-context --approval-mode never --no-session-log --approval-judge off --max-model-steps 50` with the full ticket in the prompt file. `--user-input-auto-resolve` is deliberately omitted because Muse requires session logging for that mode, while Ghost keeps session logging disabled. Muse may answer without editing files, edit files, or return blocked with concise questions. No Sol model, orchestrator skill, intent classifier, or sandbox flags.
8. Parses Muse JSONL defensively (multiple event shapes) against the small result shape (`status` completed/blocked, `summary`, `questions`, `changed_files`, `validation_performed`, `residual_risks`). If Muse answers in prose without the JSON object, Ghost posts the raw reply marked as degraded instead of failing with nothing to show. Repo prompts lead with the user's triggering message and the one-place worktree convention (base dir, branch shape, never touch the main checkout) so the model can create a further worktree itself when asked.
9. If Muse `blocked` → persist `awaiting_input`, send Linear `elicitation` with questions, stop before commit. In scratch with no repository, a task needing repo changes is answered as blocked asking which repository.
10. If the workspace is a repository worktree and files actually changed, Ghost validates worktree deterministically via existing `package.json` scripts in order `test → typecheck → lint → build` (only scripts that exist; missing `test` is not failure but recorded). Any selected check failure → fail before commit. No task-provided commands are executed. If no files changed, Muse's summary is posted directly as the Linear response and the job completes — no commit, push, PR, or validation required.
11. Requires non-empty git diff; rejects secret/private-file additions (`.env`, `credentials`, `*.pem/*.key/*.p12/*.pfx`, `id_rsa`, `tokens.json`, ghost data). Commits with sanitized `issue — title` message, pushes via SSH (no `--force`), records SHA.
12. Creates PR via GitHub REST API if `GITHUB_TOKEN` or `GH_TOKEN` is present (without logging token); treats existing open PR for branch as success. Without token, returns truthful compare URL `https://github.com/<owner>/<repo>/compare/main...<url-encoded-branch>?expand=1` and does not claim a PR was created.
13. Posts Linear `thought`/`action` updates at major phases; final `response` includes concise summary (plus branch, checks, and PR or compare URL when code was published). Failures persist `failed` with sanitized error and post `error` activity. Never logs prompts, tokens, env values, or full model/command output.

`action=prompted` (follow-up):
- Appends follow-up (truncated) to job and resumes same job if `awaiting_input`; queues if `running`; responds truthfully if `completed`/`failed` without duplicating execution.

All process spawning uses `argv` arrays with `shell:false`, timeouts, output caps, and sanitized errors. Never interpolates task text into a shell command.

## Configuration

Env vars (injected via Bitwarden `bws run`, never committed):

```
LINEAR_API_KEY                      # personal API key; or save it to ~/.config/linear/api_key (0600)
LINEAR_WEBHOOK_SECRET
GHOST_PORT=8791
GHOST_HOST=127.0.0.1
GHOST_DATA_DIR=/home/rohan/.config/ghost
# Optional:
GITHUB_TOKEN or GH_TOKEN            # create PR via REST API; otherwise compare URL
GHOST_DEFAULT_REPO=scoutline        # fallback when resolver finds 0 matches (one of: scoutline, flaggo, portfolio, coachmate)
GHOST_PROJECT_MAP={"Scoutline app":"scoutline"}  # Linear project name/id -> repo id (case-insensitive)
GHOST_REPO_SCOUTLINE_PATH=/home/rohan/projects/scoutline   # per-repo path overrides (similar for FLAGGO, PORTFOLIO, COACHMATE)
GHOST_REPO_MAP={"scoutline":"/path"}              # generic JSON map override
GHOST_MUSE_BIN=/home/rohan/.local/bin/muse
GHOST_MUSE_TIMEOUT_MS=600000
```

Jobs at `$GHOST_DATA_DIR/jobs/<session>.json` (0600, atomic), worktrees at `$GHOST_DATA_DIR/worktrees/<session>` (0700, isolated). `GHOST_DATA_DIR` itself is 0700.

Repository mapping (exact aliases, bounded):

| id | aliases | path | GitHub |
|----|---------|------|--------|
| scoutline | scoutline | /home/rohan/projects/scoutline | rohan-ahire1/scoutline |
| flaggo | flaggo | /home/rohan/projects/flaggo | rohan-ahire1/flaggo |
| portfolio | portfolio | /home/rohan/projects/portfolio | rohan-ahire1/portfolio |
| coachmate | coachmate, chess-coach, chess coach | /home/rohan/projects/coachmate | rohan-ahire1/chess-coach |

All repos use `origin/main` over SSH.

## Operational Flow & Limitations

- Deliveries are idempotent via persistent job file + in-memory per-session lock; restarts do not start duplicate work.
- Webhook `Linear-Delivery`/`webhookId` replay protection is persisted to `GHOST_DATA_DIR/webhook-deliveries.json` (24h TTL, capped at ~10k entries) and survives restarts; durable idempotency is enforced at session level via `GHOST_DATA_DIR/jobs/<session>.json` (any state `created`/`running`/`awaiting_input`/`completed`/`failed` prevents duplicate `created` execution, including after restart).
- Sessions on the same repo run concurrently in isolated worktrees; the per-repo lock only guards short shared-checkout git setup/cleanup.
- Worktrees are always based on a freshly fetched `origin/main`; the dirty user checkout is never modified or cleaned.
- Branch reuse is refused if remote branch already exists for a different job; push is never forced.
- Muse's structured output is load-bearing: Ghost defensively parses Muse JSONL (`muse-output-schema.json` documents the shape); no single event shape is assumed.
- Follow-ups resume only when the job is `awaiting_input`; otherwise they are queued or reported truthfully.
- If `GITHUB_TOKEN` is absent, Ghost pushes the branch and returns the compare link — it never claims a PR was created.
- **Worktree lifecycle & retention:** Isolated worktrees live under `GHOST_DATA_DIR/worktrees/<session>` (0700). Ghost performs best-effort cleanup of the exact verified isolated path via `git worktree remove --force` **only** for terminal `completed` and `failed` outcomes, validated to be strictly inside `GHOST_DATA_DIR/worktrees` (no traversal, no sibling, not the target checkout). `awaiting_input` is **never** cleaned because the job may resume. After worktree removal, the session's local `ghost/*` branch is pruned when it has no commits ahead of `origin/main` or its tip already equals the pushed remote (unique work is never deleted). Cleanup logs safe metadata only (`worktreePath`, exitCode) and failure does not alter the truthful terminal result; the target checkout is never touched/cleaned/reset.

## Run

```bash
npm install
npm run build
# via bws:
bws run --project-id <project-id> -- node dist/index.js
# or locally for dev with staging copy:
GHOST_DATA_DIR=/tmp/ghost-data npm start
```

Systemd: `ghost.service` → `127.0.0.1:8791` behind Caddy `ghost.rohanahire.com`.

## Tests

```bash
npm test          # builds then runs Node test runner (repoResolver, jobStore, branch, command, parser, checks, secret rejection, PR fallback, lifecycle, Muse direct path)
npm run build     # TypeScript strict, Node 18+
```

Coverage highlights: repo resolution boundaries, scratch fallback for zero/multiple matches, durable/idempotent state with atomic writes & restart, safe branch naming, `shell:false` argv spawning with timeouts/caps, Muse CLI invocation shape, structured-result parsing, deterministic check selection, secret-path rejection, PR vs compare URL, `created` vs `prompted` lifecycle (duplicate suppression, awaiting_input resume).

## Deployability

Deploy with the safe script (backup → sync → build+test on VPS → restart → health check → auto-rollback):

```bash
./scripts/deploy.sh
```

Backups land in `~/backups/ghost-deploy-<timestamp>/` on the VPS and are kept for manual rollback. The script aborts before restart if `npm test` fails on the VPS.

No `gh` CLI required. GitHub PRs require `GITHUB_TOKEN`; SSH push works without it.

## Ops

Over SSH (these endpoints refuse non-loopback clients with 404):

```bash
curl -s 127.0.0.1:8791/ops | head -c 2000        # counts, last failure, recent jobs
curl -s 127.0.0.1:8791/jobs | head -c 2000       # all job summaries
curl -s 127.0.0.1:8791/jobs/<session-id>         # one job's detail
sudo journalctl -u ghost --since '1 hour ago'    # live logs
```

Set `GHOST_DEFAULT_REPO` (e.g. `scoutline`) in the systemd unit as a routing
safety net, and `GHOST_PROJECT_MAP` (`{"Linear project name":"repo-id"}`) so
tickets route by Linear project without needing the repo name in the title.

## Environment Isolation (Child Processes)

Ghost runs under `bws run`, so `process.env` contains `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, `BWS_ACCESS_TOKEN`, optional `GITHUB_TOKEN`/`GH_TOKEN`, and `MODEL_API_KEY`. Spawned Muse/git/npm processes must not inherit unrelated service secrets.

- **Central environment builder** (`src/childEnv.ts`): `buildSafeEnv()` constructs a least-privilege environment limited to operational variables needed for executables and SSH/tool config — `PATH`, `HOME`, `USER`, `LOGNAME`, locale (`LANG`, `LC_*`), `TERM`, `TMPDIR`/`TMP`/`TEMP`, `SHELL`, `SSH_AUTH_SOCK`, and narrowly justified tool settings (`FORCE_COLOR`, `COLORTERM`, `NO_COLOR`, `TERM_PROGRAM`, `NODE_ENV`, `CI`, `XDG_*`, `GIT_SSH*`, `SSH_AGENT_PID`). All `LINEAR_*`, `BWS_*`, `GITHUB_TOKEN`/`GH_TOKEN`, `OPENAI_API_KEY`, `MODEL_API_KEY`, and other service credentials are explicitly stripped by default. No arbitrary task-controlled names are allowed.
- **Git and validation commands** (`src/gitPipeline.ts`, `src/validation.ts` via `runCommand`) use this safe environment and receive no model/API/service tokens. `runCommand` defaults to `buildSafeEnv()` when the caller does not supply an explicit `env`; when `env` is supplied it *replaces* `process.env` entirely (Node `spawn` semantics, no merge).
- **Muse worker** (`src/museRunner.ts`) uses a separately constructed environment via `buildMuseEnv()`: the safe operational env plus only the explicitly allowed model credential(s) genuinely required for Muse. On this VPS that is **`MODEL_API_KEY`** — the sole allowlisted credential (`ALLOWED_MODEL_CREDENTIALS = ["MODEL_API_KEY"]` in `src/childEnv.ts`). Linear/BWS/GitHub secrets and `OPENAI_API_KEY` are never passed. `HOME` and `PATH` are preserved so Muse can use its local auth/config. The allowlist is static and documented, not task-controlled.
- **No secret leakage via logs or persisted state**: central safe-error handling (`sanitizeError`/`redactKnownSecrets`/`redactWithValue`) redacts exact opaque values for all known service secrets (`LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, `BWS_ACCESS_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `MODEL_API_KEY`, `OPENAI_API_KEY`) — literal, not pattern-based — before logs, persisted job errors (`GHOST_DATA_DIR/jobs/*.json`), and Linear `thought`/`error`/`response` messages. Environment names/values beyond static safe metadata are never logged.

Example (no real values):

```ts
import { buildSafeEnv, buildMuseEnv } from "./childEnv.js";
import { runCommand } from "./commandRunner.js";
// Git/validation: safe env, no tokens
await runCommand({ command: "git", args: ["fetch", "origin", "main"] });
// Muse: safe env + MODEL_API_KEY only
await runCommand({ command: museBin, args, env: buildMuseEnv() });
```

## Security

- Never logs tokens, secrets, headers, full promptContext, or full command output.
- Timing-safe `Linear-Signature` comparison; 60s `webhookTimestamp` window + dedup.
- `state` is 256-bit `crypto.randomBytes`, one-time, 10 min TTL.
- `express.raw` for webhook to preserve exact bytes for HMAC.
- No shell execution; argv arrays, `shell:false`, timeouts, output caps, sanitized errors.
- Validates repo only via alias boundaries; never accepts arbitrary filesystem path from payload.
- Reject secret file additions before commit; never force-push.
