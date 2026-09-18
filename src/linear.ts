import { TokenStore, type StoredTokens } from "./storage.js";
import { sanitizeError } from "./commandRunner.js";

const OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
const GRAPHQL_URL = "https://api.linear.app/graphql";

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

function formEncode(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export async function exchangeCodeForTokens(opts: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<OAuthTokenResponse> {
  const body = formEncode({
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    grant_type: "authorization_code",
  });

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    // Do not leak secrets in error
    throw new Error(`Token exchange failed: ${res.status} ${text.slice(0, 400)}`);
  }
  let data: OAuthTokenResponse;
  try {
    data = JSON.parse(text) as OAuthTokenResponse;
  } catch {
    throw new Error(`Token exchange returned invalid JSON: ${text.slice(0, 400)}`);
  }
  if (!data.access_token) {
    throw new Error(`Token exchange missing access_token: ${text.slice(0, 400)}`);
  }
  return data;
}

export async function refreshTokens(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<OAuthTokenResponse> {
  const body = formEncode({
    refresh_token: opts.refreshToken,
    grant_type: "refresh_token",
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Refresh failed: ${res.status} ${text.slice(0, 400)}`);
  }
  let data: OAuthTokenResponse;
  try {
    data = JSON.parse(text) as OAuthTokenResponse;
  } catch {
    throw new Error(`Refresh returned invalid JSON: ${text.slice(0, 400)}`);
  }
  if (!data.access_token) {
    throw new Error(`Refresh missing access_token`);
  }
  return data;
}

// Persist helper
export function tokensFromResponse(resp: OAuthTokenResponse, prevRefresh?: string): StoredTokens {
  const now = new Date();
  const expiresIn = typeof resp.expires_in === "number" ? resp.expires_in : 24 * 60 * 60;
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);
  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token || prevRefresh || "",
    token_type: resp.token_type,
    expires_in: expiresIn,
    expires_at: expiresAt.toISOString(),
    obtained_at: now.toISOString(),
    scope: resp.scope,
  };
}

// Auth: OAuth app tokens first — the ONLY auth Linear accepts for agent
// activity posts (personal API keys get 403 on those mutations). Falls back
// to the personal key for reads when no OAuth tokens are installed yet.
// Header schemes differ per method: `Bearer` for OAuth, raw for personal
// keys (Linear rejects `Bearer lin_api_...`).
export class LinearTokenManager {
  private refreshPromise: Promise<StoredTokens | null> | null = null;

  constructor(
    private tokenStore: TokenStore,
    private clientId: string,
    private clientSecret: string,
    private personalKey: string,
  ) {}

  private async loadOAuthTokens(): Promise<StoredTokens | null> {
    const stored = this.tokenStore.load();
    if (!stored) return null;
    if (!this.tokenStore.isExpired(stored)) return stored;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh(stored).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async doRefresh(stored: StoredTokens): Promise<StoredTokens | null> {
    if (!stored.refresh_token) {
      console.error("[ghost] No refresh_token available, cannot refresh");
      return null;
    }
    try {
      const resp = await refreshTokens({
        refreshToken: stored.refresh_token,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
      });
      const next = tokensFromResponse(resp, stored.refresh_token);
      // Linear rotates refresh tokens; persist the newly returned one
      this.tokenStore.save(next);
      console.log("[ghost] Access token refreshed successfully");
      return next;
    } catch (err) {
      console.error(JSON.stringify({ msg: "Token refresh failed", error: sanitizeError((err as Error).message, 500) }));
      return null;
    }
  }

  async getValidAccessToken(): Promise<string | null> {
    const oauth = await this.loadOAuthTokens();
    if (oauth) return oauth.access_token;
    const key = (this.personalKey || "").trim();
    return key !== "" ? key : null;
  }

  async getAuthHeader(): Promise<string | null> {
    const oauth = await this.loadOAuthTokens();
    if (oauth) return `Bearer ${oauth.access_token}`;
    const key = (this.personalKey || "").trim();
    return key !== "" ? key : null;
  }
}

// ---------- GraphQL ----------
export interface AgentActivityContent {
  type: "thought" | "action" | "response" | "error" | "elicitation";
  body?: string;
  action?: string;
  parameter?: string;
  result?: string;
}

const AGENT_ACTIVITY_MUTATION = `
mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) {
    success
    agentActivity {
      id
    }
  }
}
`;

export async function createAgentActivity(opts: {
  /** Full Authorization header value (scheme depends on the auth method). */
  authHeader: string;
  agentSessionId: string;
  content: AgentActivityContent;
  signal?: string;
  signalMetadata?: Record<string, unknown>;
  ephemeral?: boolean;
}): Promise<boolean> {
  const variables = {
    input: {
      agentSessionId: opts.agentSessionId,
      content: opts.content,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.signalMetadata ? { signalMetadata: opts.signalMetadata } : {}),
      ...(typeof opts.ephemeral === "boolean" ? { ephemeral: opts.ephemeral } : {}),
    },
  };

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: opts.authHeader,
    },
    body: JSON.stringify({ query: AGENT_ACTIVITY_MUTATION, variables }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`[ghost] agentActivityCreate HTTP ${res.status}: ${sanitizeError(text.slice(0, 500), 500)}`);
    return false;
  }

  try {
    const json = JSON.parse(text);
    if (json.errors) {
      console.error(`[ghost] agentActivityCreate GraphQL errors: ${sanitizeError(JSON.stringify(json.errors).slice(0, 800), 800)}`);
      return false;
    }
    if (json.data?.agentActivityCreate?.success) {
      return true;
    }
    console.error(`[ghost] agentActivityCreate unexpected response: ${sanitizeError(text.slice(0, 800), 800)}`);
    return false;
  } catch {
    console.error(`[ghost] agentActivityCreate invalid JSON: ${sanitizeError(text.slice(0, 500), 500)}`);
    return false;
  }
}
