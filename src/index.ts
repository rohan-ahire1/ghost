import express from "express";
import crypto from "node:crypto";
import { loadConfig } from "./config.js";
import { TokenStore, OAuthStateStore, WebhookReplayStore } from "./storage.js";
import { exchangeCodeForTokens, tokensFromResponse, LinearTokenManager } from "./linear.js";
import {
  handleAgentSessionCreated,
  handleAgentSessionPrompted,
  extractGhostContext,
  logAgentSessionMetadata,
} from "./agentSession.js";
import { sanitizeError } from "./commandRunner.js";
import { JobStore } from "./jobStore.js";
import { summarizeJob, detailJob, getOpsSnapshot } from "./ops.js";

const config = loadConfig();
const startedAt = new Date();
const tokenStore = new TokenStore(config.dataDir);
const stateStore = new OAuthStateStore(config.dataDir);
const replayStore = new WebhookReplayStore(config.dataDir);
const tokenManager = new LinearTokenManager(tokenStore, config.clientId, config.clientSecret, config.linearApiKey);
const jobStore = new JobStore(config.dataDir);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback");

// ---------- helpers ----------
function verifySignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || typeof signatureHeader !== "string") return false;
  try {
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const sigBuf = Buffer.from(signatureHeader, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length) {
      // still do timingSafeEqual on same-length buffers to avoid length leak timing
      // compare expected with itself to waste time, then return false
      try { crypto.timingSafeEqual(expBuf, expBuf); } catch {}
      return false;
    }
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    out[k.trim()] = rest.join("=").trim();
  }
  return out;
}

// ---------- Health ----------
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "ghost" });
});

// Also handle HEAD for health
app.head("/health", (_req, res) => {
  res.status(200).end();
});

// ---------- Loopback-only ops (job visibility without Linear) ----------
// Caddy exposes this service publicly for Linear webhooks, so /ops and /jobs
// refuse non-loopback clients with a plain 404. With `trust proxy loopback`,
// req.ip is the real client IP. Use these over SSH: `curl 127.0.0.1:8791/ops`.
function isLoopback(req: express.Request): boolean {
  const ip = req.ip || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

app.get("/ops", (req, res) => {
  if (!isLoopback(req)) {
    res.status(404).json({ error: "Not found", path: req.path });
    return;
  }
  try {
    res.status(200).json(getOpsSnapshot(jobStore, startedAt));
  } catch (err) {
    console.error(JSON.stringify({ msg: "ops error", error: sanitizeError((err as Error).message, 300) }));
    res.status(500).json({ error: "Internal error" });
  }
});

app.get("/jobs", (req, res) => {
  if (!isLoopback(req)) {
    res.status(404).json({ error: "Not found", path: req.path });
    return;
  }
  try {
    const all = jobStore
      .listAll()
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    res.status(200).json({ jobs: all.map(summarizeJob) });
  } catch (err) {
    console.error(JSON.stringify({ msg: "jobs error", error: sanitizeError((err as Error).message, 300) }));
    res.status(500).json({ error: "Internal error" });
  }
});

app.get("/jobs/:id", (req, res) => {
  if (!isLoopback(req)) {
    res.status(404).json({ error: "Not found", path: req.path });
    return;
  }
  try {
    const rec = jobStore.load(req.params.id);
    if (!rec) {
      res.status(404).json({ error: "Unknown job", id: req.params.id.slice(0, 64) });
      return;
    }
    res.status(200).json(detailJob(rec));
  } catch (err) {
    console.error(JSON.stringify({ msg: "job detail error", error: sanitizeError((err as Error).message, 300) }));
    res.status(500).json({ error: "Internal error" });
  }
});

// ---------- OAuth install (one-time: app tokens are the only auth that can post agent activities) ----------
app.get("/linear/install", (req, res) => {
  try {
    const state = stateStore.generate();
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: "read,write,app:mentionable,app:assignable",
      actor: "app",
      state,
    });

    const authorizeUrl = `https://linear.app/oauth/authorize?${params.toString()}`;
    // Never log state or secrets
    console.log(JSON.stringify({ msg: "OAuth install redirect", hasState: true }));
    res.redirect(302, authorizeUrl);
  } catch (err) {
    console.error(JSON.stringify({ msg: "install error", error: sanitizeError((err as Error).message, 300) }));
    res.status(500).json({ error: "Failed to initiate OAuth" });
  }
});

// ---------- OAuth callback ----------
app.get("/linear/oauth/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  // Linear may send error param on denial
  const error = typeof req.query.error === "string" ? req.query.error : undefined;
  if (error) {
    console.error(JSON.stringify({ msg: "OAuth callback error param", error: sanitizeError(error, 200) }));
    res.status(400).send(`<h1>OAuth error</h1><p>${escapeHtml(error)}</p>`);
    return;
  }

  if (!code || !state) {
    res.status(400).send("<h1>Missing code or state</h1>");
    return;
  }

  if (!stateStore.verifyAndConsume(state)) {
    console.error(JSON.stringify({ msg: "OAuth state verification failed" }));
    res.status(400).send("<h1>Invalid or expired state</h1><p>Please try <a href=\"/linear/install\">installing again</a>.</p>");
    return;
  }

  try {
    const tokenResp = await exchangeCodeForTokens({
      code,
      redirectUri: config.redirectUri,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });

    const stored = tokensFromResponse(tokenResp);
    tokenStore.save(stored);
    // Never log tokens
    console.log(JSON.stringify({ msg: "OAuth tokens persisted", hasAccessToken: true }));

    res.status(200).send(`
      <html>
        <head><title>Ghost installed</title></head>
        <body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 20px;">
          <h1>Ghost installed successfully ✓</h1>
          <p>Linear OAuth completed. Tokens persisted securely.</p>
          <p>Ghost will now receive <code>AgentSessionEvent</code> webhooks and acknowledge sessions.</p>
          <p><a href="/health">Health check</a></p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error(JSON.stringify({ msg: "OAuth exchange failed", error: sanitizeError((err as Error).message, 400) }));
    res.status(500).send("<h1>OAuth exchange failed</h1><p>Check service logs (no secrets logged). Try <a href=\"/linear/install\">retrying</a>.</p>");
  }
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// ---------- Webhook ----------
// Must capture raw body before JSON parsing. Mount raw parser ONLY on this route.
app.post(
  "/linear/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
  async (req, res) => {
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");

    const signature = req.headers["linear-signature"] as string | undefined;
    const deliveryId = (req.headers["linear-delivery"] as string | undefined) || "";
    // Also check webhookId from payload after parsing, but we need raw verification first

    if (!verifySignature(rawBody, signature, config.webhookSecret)) {
      console.error(JSON.stringify({ msg: "Webhook signature invalid", deliveryId }));
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString("utf-8"));
    } catch {
      console.error(JSON.stringify({ msg: "Webhook invalid JSON", deliveryId }));
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }

    // Timestamp replay protection: ~60 seconds
    const webhookTimestamp: number | undefined =
      typeof payload.webhookTimestamp === "number" ? payload.webhookTimestamp : undefined;

    if (typeof webhookTimestamp === "number") {
      const now = Date.now();
      const diff = Math.abs(now - webhookTimestamp);
      // If webhookTimestamp is in seconds instead of ms, allow heuristic: if <1e12, treat as seconds*1000
      // But spec says ms. We'll assume ms; if seconds, diff would be huge and reject, so also handle seconds.
      // Detect seconds vs ms: if timestamp < 1e12 (approx year 2001 in ms), it's seconds
      let normalizedTimestamp = webhookTimestamp;
      if (webhookTimestamp < 1e12) {
        normalizedTimestamp = webhookTimestamp * 1000;
      }
      const normalizedDiff = Math.abs(now - normalizedTimestamp);
      if (normalizedDiff > 60 * 1000) {
        console.error(
          JSON.stringify({
            msg: "Webhook timestamp stale",
            deliveryId,
            webhookTimestamp,
            diffMs: normalizedDiff,
          }),
        );
        res.status(401).json({ error: "Webhook timestamp stale" });
        return;
      }
    } else {
      // If missing timestamp, we still accept but log; spec says verify webhookTimestamp is significantly stale
      console.warn(JSON.stringify({ msg: "Webhook missing webhookTimestamp", deliveryId }));
    }

    // Only AgentSessionEvent carries work; Linear also delivers Issue,
    // Attachment, label, and other subscription noise, which is acked
    // silently (no log line, no dispatch, no replay entry) to keep logs
    // readable and the persisted replay store small.
    const type = payload.type;
    if (type !== "AgentSessionEvent") {
      res.status(200).json({ ok: true, ignored: type || "unknown" });
      return;
    }

    // Delivery/webhookId replay protection
    const replayId = deliveryId || payload.webhookId || "";
    if (replayId) {
      const fresh = replayStore.checkAndMark(replayId);
      if (!fresh) {
        console.warn(JSON.stringify({ msg: "Webhook duplicate delivery, acking", deliveryId, webhookId: payload.webhookId }));
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }
    }

    logAgentSessionMetadata(payload);

    // Immediately return 200 after validating and queue/dispatching
    res.status(200).json({ ok: true });

    // Dispatch work without blocking response
    setImmediate(() => {
      void dispatchWebhookWork(payload).catch((err) => {
        console.error(JSON.stringify({ msg: "dispatch error", error: sanitizeError((err as Error).message, 500) }));
      });
    });
  },
);

async function dispatchWebhookWork(payload: any): Promise<void> {
  const type = payload.type;
  const action = payload.action;

  if (type !== "AgentSessionEvent") {
    // For now, only AgentSessionEvent is important; ignore others but log
    return;
  }

  if (action === "created") {
    const ctx = extractGhostContext(payload);
    if (!ctx) return;
    // Start background Ghost job - isolated from HTTP process, no shell execution
    // Structuring so later we can plug in pipeline:
    // repo/scratch workspace -> direct Muse -> optional validation/git/PR -> Linear update
    await handleAgentSessionCreated(ctx, tokenManager);
    return;
  }

  if (action === "prompted") {
    await handleAgentSessionPrompted(payload, tokenManager);
    return;
  }

  console.log(JSON.stringify({ msg: "AgentSessionEvent unhandled action", action }));
}

// ---------- Fallback JSON parser for other routes ----------
app.use(express.json({ limit: "1mb" }));

// 404 for unknown
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.path });
});

// Error handler (no secrets in response)
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(JSON.stringify({ msg: "Unhandled error", error: sanitizeError(err instanceof Error ? err.message : String(err), 500) }));
  res.status(500).json({ error: "Internal error" });
});

const server = app.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      msg: "Ghost service listening",
      host: config.host,
      port: config.port,
      env: config.nodeEnv,
    }),
  );
});

// Graceful shutdown
function shutdown(signal: string): void {
  console.log(JSON.stringify({ msg: `Received ${signal}, shutting down` }));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
