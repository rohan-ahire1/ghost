import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./fsAtomic.js";

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_in?: number;
  expires_at?: string; // ISO timestamp when access token expires
  obtained_at: string;
  scope?: string;
}

export interface OAuthStateEntry {
  state: string;
  createdAt: string;
  expiresAt: string;
}

// ---------- Token store (OAuth app tokens: the only auth that can post agent activities) ----------
export class TokenStore {
  private filePath: string;

  constructor(private dataDir: string) {
    this.filePath = join(dataDir, "tokens.json");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try { chmodSync(dataDir, 0o700); } catch {}
  }

  load(): StoredTokens | null {
    if (!existsSync(this.filePath)) return null;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as StoredTokens;
      if (!parsed.access_token || !parsed.refresh_token) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  save(tokens: StoredTokens): void {
    atomicWriteJson(this.filePath, tokens);
  }

  isExpired(tokens: StoredTokens, skewMs = 5 * 60 * 1000): boolean {
    if (!tokens.expires_at) return false; // no expiry info, assume valid
    const exp = Date.parse(tokens.expires_at);
    if (!Number.isFinite(exp)) return false;
    return Date.now() > exp - skewMs;
  }
}

// ---------- OAuth state store ----------
export class OAuthStateStore {
  private states = new Map<string, OAuthStateEntry>();
  private filePath: string;
  private loaded = false;
  private ttlMs = 10 * 60 * 1000;

  constructor(private dataDir: string) {
    this.filePath = join(dataDir, "oauth-states.json");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const arr = JSON.parse(raw) as OAuthStateEntry[];
      for (const e of arr) {
        if (e.state && e.expiresAt) {
          const exp = Date.parse(e.expiresAt);
          if (Number.isFinite(exp) && exp > Date.now()) {
            this.states.set(e.state, e);
          }
        }
      }
    } catch {}
  }

  private persist(): void {
    try {
      const arr = Array.from(this.states.values());
      atomicWriteJson(this.filePath, arr);
    } catch {}
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [k, v] of this.states) {
      const exp = Date.parse(v.expiresAt);
      if (!Number.isFinite(exp) || exp <= now) this.states.delete(k);
    }
  }

  generate(): string {
    this.ensureLoaded();
    this.cleanup();
    const state = randomBytes(32).toString("hex"); // 64 hex chars = 256 bits
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    const entry: OAuthStateEntry = {
      state,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    this.states.set(state, entry);
    this.persist();
    return state;
  }

  verifyAndConsume(state: string): boolean {
    this.ensureLoaded();
    this.cleanup();
    if (!state || typeof state !== "string") return false;
    const entry = this.states.get(state);
    if (!entry) return false;
    // one-time use
    this.states.delete(state);
    this.persist();
    const exp = Date.parse(entry.expiresAt);
    if (!Number.isFinite(exp) || exp <= Date.now()) return false;
    return true;
  }

  has(state: string): boolean {
    this.ensureLoaded();
    return this.states.has(state);
  }
}

// ---------- Replay protection for webhooks ----------
// File-backed when constructed with a dataDir, so a restart cannot cause
// duplicate work from redelivered webhooks. Without a dataDir it behaves as
// a pure in-memory store (tests, callers that do not need durability).
export class WebhookReplayStore {
  private seen = new Map<string, number>(); // webhookId/deliveryId -> expiresAt ms
  private ttlMs = 24 * 60 * 60 * 1000; // 24h
  private filePath: string | null = null;
  private loaded = false;

  constructor(dataDir?: string) {
    if (dataDir && dataDir.trim()) {
      this.filePath = join(dataDir.trim(), "webhook-deliveries.json");
      mkdirSync(dataDir.trim(), { recursive: true, mode: 0o700 });
    }
  }

  private ensureLoaded(): void {
    if (this.loaded || !this.filePath) return;
    this.loaded = true;
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const arr = JSON.parse(raw) as Array<{ id: string; expiresAt: number }>;
      if (!Array.isArray(arr)) return;
      const now = Date.now();
      for (const e of arr.slice(0, 10000)) {
        if (typeof e?.id === "string" && typeof e?.expiresAt === "number" && e.expiresAt > now) {
          this.seen.set(e.id, e.expiresAt);
        }
      }
    } catch {}
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      const arr = Array.from(this.seen.entries()).map(([id, expiresAt]) => ({ id, expiresAt }));
      atomicWriteJson(this.filePath, arr);
    } catch {}
  }

  checkAndMark(id: string): boolean {
    if (!id) return true;
    this.ensureLoaded();
    const now = Date.now();
    this.cleanup(now);
    if (this.seen.has(id)) {
      return false; // duplicate
    }
    this.seen.set(id, now + this.ttlMs);
    // trim if unbounded growth
    if (this.seen.size > 10000) {
      // remove oldest
      const first = this.seen.keys().next().value;
      if (first) this.seen.delete(first);
    }
    this.persist();
    return true;
  }

  private cleanup(now: number): void {
    for (const [k, exp] of this.seen) {
      if (exp <= now) this.seen.delete(k);
    }
  }
}
