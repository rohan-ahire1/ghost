import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GhostConfig {
  port: number;
  host: string;
  webhookSecret: string;
  /** OAuth app credentials (app tokens are the only auth that can post agent activities). */
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Personal API key fallback for reads when OAuth tokens are not installed. */
  linearApiKey: string;
  dataDir: string;
  nodeEnv: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env: ${name}`);
  }
  return v.trim();
}

function loadApiKey(): string {
  const fromEnv = process.env.LINEAR_API_KEY;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim();
  // Fallback to the 0600 key file so the systemd unit needs no vault change.
  const keyFile = join(homedir(), ".config", "linear", "api_key");
  if (existsSync(keyFile)) {
    const v = readFileSync(keyFile, "utf-8").trim();
    if (v !== "") return v;
  }
  throw new Error("Missing Linear API key: set LINEAR_API_KEY or save it to ~/.config/linear/api_key");
}

export function loadConfig(): GhostConfig {
  const port = Number(process.env.GHOST_PORT || process.env.PORT || 8791);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid GHOST_PORT: ${process.env.GHOST_PORT}`);
  }
  const host = (process.env.GHOST_HOST || "127.0.0.1").trim();
  const dataDir =
    (process.env.GHOST_DATA_DIR || "/home/rohan/.config/ghost").trim();
  const nodeEnv = (process.env.NODE_ENV || "production").trim();

  const clientId = requireEnv("LINEAR_CLIENT_ID");
  const clientSecret = requireEnv("LINEAR_CLIENT_SECRET");
  const redirectUri = requireEnv("LINEAR_REDIRECT_URI");

  return {
    port,
    host,
    webhookSecret: requireEnv("LINEAR_WEBHOOK_SECRET"),
    clientId,
    clientSecret,
    redirectUri,
    linearApiKey: loadApiKey(),
    dataDir,
    nodeEnv,
  };
}
