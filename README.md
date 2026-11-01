# Ghost

Ghost is a coding agent you talk to from Linear. Mention it on a ticket and it reads the request, decides whether code needs to change, makes the change in an isolated git worktree, runs the repo's checks, and opens a pull request. If it needs more information, it asks in the ticket and picks up again when you reply.

It's a small Node.js and TypeScript service with one runtime dependency (Express): about 5,100 lines of source and 208 tests. It ran on a single VPS against four of my repos and is no longer deployed. The code is here to read.

## How a request flows

```mermaid
flowchart TD
    A[Linear webhook] --> B[Verify signature, drop replays, reply 200]
    B --> C[Save job to disk]
    C --> D{Chat gate<br/>message and ticket id only}
    D -- small talk --> R[Reply in Linear]
    D -- needs the ticket --> E{Ticket stage<br/>full ticket, no tools}
    E -- answer --> R
    E -- missing info --> Q[Ask in Linear, wait for a reply]
    Q --> D
    E -- wants work --> F[Pick repo, create worktree]
    F --> G[Work stage<br/>model edits the worktree]
    G --> H[Run test, typecheck, lint, build]
    H -- fail --> X[Report the failure]
    H -- pass --> I[Block secret files, commit, push]
    I --> J[Open PR or return a compare link]
    J --> R
```

Each stage costs more than the one before it, so the model only gets more context and more steps when the request calls for them. The chat gate gets 5 steps and never sees the ticket body. The ticket stage gets 15 steps and no tools. The work stage gets 50 steps inside the worktree. There are no word lists or hardcoded intents: the model decides, and any output Ghost can't parse falls back to plain chat.

## Design decisions

The model does the thinking and Ghost does everything that has to be reliable. Ghost owns the worktree, the checks, the commit, the push, the pull request and the status updates in Linear, so a model that says the tests passed can't get broken code published.

Webhooks return 200 straight away and the work runs in the background. Every job is a JSON file written atomically, so a restart or a duplicate delivery never runs the same work twice. Delivery IDs are kept on disk for 24 hours to stop replays.

Your checkout is never touched. Each session gets its own worktree from a fresh `origin/main`, so sessions on the same repo run at once without colliding. Ghost never force-pushes, and it won't reuse a remote branch that belongs to another job. Concurrency is capped at 2 model runs by default.

Ghost never guesses a repo. It tries the Linear label, then the project map, then an alias in the title or prompt, then the session's known repo. If that's still ambiguous, it asks you.

Ghost only reports what happened. If there's no GitHub token, it pushes the branch and returns a compare link without claiming a PR exists. If the model answers in prose instead of JSON, Ghost posts the reply and marks it as degraded.

## Security

The agent runs arbitrary repo code, so its environment is built from an allowlist. `src/childEnv.ts` builds a minimal environment for git, test and build commands, with no service credentials. The model process gets that plus `MODEL_API_KEY` and nothing else. Linear, GitHub and Bitwarden secrets never reach it.

Other protections:

- Linear signatures are checked with a timing-safe HMAC, with a 60-second timestamp window
- All processes spawn from argv arrays with `shell: false`, timeouts and output caps, so ticket text never reaches a shell
- Known secret values are redacted before anything is written to logs, job files or Linear
- `.env`, `*.pem`, `*.key`, `id_rsa`, `tokens.json` and similar files are rejected before commit
- `/ops` and `/jobs` answer only on loopback

## Layout

| File | What it does |
|---|---|
| `src/index.ts` | HTTP server and webhook verification |
| `src/agentSession.ts` | Session lifecycle: created, prompted, follow-ups |
| `src/pipeline.ts` | The chat, ticket and work stages |
| `src/chat.ts` | Chat gate and conversation state |
| `src/museRunner.ts` | Runs the model CLI and parses its output defensively |
| `src/gitPipeline.ts` | Worktrees, commit, push and cleanup |
| `src/validation.ts` | Picks and runs repo checks, rejects secret files |
| `src/github.ts` | Pull requests and compare links |
| `src/repoResolver.ts` | Maps a ticket to a repo |
| `src/jobStore.ts` | Durable job state with atomic writes |
| `src/childEnv.ts` | Environment allowlists for child processes |
| `src/ops.ts` | Loopback status endpoints |

## Running it

Ghost was built for one person's setup, so a few steps below need code edits. You need:

- Node 18 or newer
- Admin access to a Linear workspace
- The Muse Code CLI, installed and signed in
- A public HTTPS URL that forwards to Ghost, from a reverse proxy or a tunnel
- Local clones of your repos with SSH push access to `origin`

### 1. Install and test

```bash
git clone https://github.com/rohan-ahire1/ghost.git
cd ghost
npm install
npm test
```

### 2. Point Ghost at your repos

Replace the `DEFAULT_REPOS` list in `src/repoResolver.ts` with your own repos. Each entry has an id, aliases, a local path, the GitHub `owner/repo` and the default branch. The list is compiled in, and `GHOST_REPO_MAP` can only change the paths of repos already on it. The git steps use `origin/main`, so each repo needs a `main` branch.

If you don't use Muse Code, the model calls are in `src/museRunner.ts`. The provider and model are constants at the top of that file, and the rest of Ghost only depends on the JSON result it parses.

### 3. Create the Linear app

Create an OAuth application at [linear.app/settings/api/applications/new](https://linear.app/settings/api/applications/new) and set:

- Callback URL: `https://your-host/linear/oauth/callback`
- Webhook URL: `https://your-host/linear/webhook`
- Webhook events: Agent session events

Copy the client ID, client secret and webhook signing secret. Then create a personal API key under your Linear security settings. Linear's [agent docs](https://linear.app/developers/agents) have the details.

### 4. Start Ghost

```bash
npm run build

export LINEAR_CLIENT_ID=...
export LINEAR_CLIENT_SECRET=...
export LINEAR_REDIRECT_URI=https://your-host/linear/oauth/callback
export LINEAR_WEBHOOK_SECRET=...
export LINEAR_API_KEY=...
export GHOST_DATA_DIR="$HOME/.config/ghost"
export GHOST_MUSE_BIN="$(command -v muse)"
export GITHUB_TOKEN=...   # optional

npm start
```

Ghost listens on `127.0.0.1:8791`. Forward your public URL to that port, then check `https://your-host/health`. It should return `{"status":"ok","service":"ghost"}`.

### 5. Install it in your workspace

Open `http://127.0.0.1:8791/linear/install` in a browser on the same machine, or through an SSH tunnel. This route only answers on loopback. Approve the install as a workspace admin. Linear needs this app install because a personal API key can't post agent activity.

### 6. Try it

Mention the app on a Linear issue and name one of your repos, for example "@ghost add a health check to my-repo". You should see updates in the issue, then a pull request or a compare link. If nothing happens, `curl 127.0.0.1:8791/ops` shows recent jobs and the last failure.

### Settings

| Variable | Purpose |
|---|---|
| `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` | Linear OAuth app. Required |
| `LINEAR_REDIRECT_URI` | Must match the app's callback URL. Required |
| `LINEAR_WEBHOOK_SECRET` | Verifies incoming webhooks. Required |
| `LINEAR_API_KEY` | Personal key for reads. Required, or save it to `~/.config/linear/api_key` |
| `GHOST_DATA_DIR` | Jobs, worktrees and tokens. Set this, because the default is my home folder |
| `GHOST_MUSE_BIN` | Model CLI path. Set this for the same reason |
| `MODEL_API_KEY` | The only credential passed to the model process, if your CLI needs one |
| `GHOST_PORT`, `GHOST_HOST` | Bind address, default `127.0.0.1:8791` |
| `GITHUB_TOKEN` or `GH_TOKEN` | Opens PRs. Without it you get a compare link |
| `GHOST_PROJECT_MAP` | JSON map from Linear project to repo id |
| `GHOST_REPO_MAP` | JSON map from repo id to local path |
| `GHOST_MAX_CONCURRENT_MUSE` | Parallel model runs, 1 to 8, default 2 |
| `GHOST_MUSE_TIMEOUT_MS` | Model run timeout, default 600000 |

`scripts/deploy.sh` backs up the current release, syncs the code, builds and tests on the server, restarts, checks health, and rolls back on failure. Its SSH target and paths are mine, so edit them before using it.

## Tests

`npm test` builds the project and runs the Node test runner. The suite covers the chat gate, ticket flow, repo resolution, restart and duplicate handling, branch naming, command spawning, model output parsing, secret file rejection, environment isolation and the PR fallback.
