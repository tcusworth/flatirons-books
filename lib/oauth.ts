import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";
import { safeEqual } from "./crypto";

/**
 * A small OAuth 2.1 authorization server for MCP connectors (single owner).
 * - Authorization code + PKCE (S256 only), public clients by default
 * - Dynamic Client Registration (RFC 7591) and Client ID Metadata Documents (client_id is an https URL)
 * - Rotating refresh tokens; tokens stored as SHA-256 hashes
 */

export const ACCESS_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days
const CODE_TTL_SECONDS = 5 * 60;

export const SCOPE = "books";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function token(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

/** Public origin of the app. APP_URL wins, then Netlify's URL, then the request's own origin. */
export function baseUrl(req?: Request): string {
  const env = (process.env.APP_URL || process.env.URL)?.replace(/\/$/, "");
  if (env) return env;
  if (req) {
    const u = new URL(req.url);
    const proto = req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "");
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? u.host;
    return `${proto}://${host}`;
  }
  return "http://localhost:3000";
}

export function mcpUrl(base: string) {
  return `${base}/api/mcp`;
}

export function protectedResourceMetadata(base: string) {
  return {
    resource: mcpUrl(base),
    authorization_servers: [base],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: process.env.APP_NAME || "Flatirons Books",
  };
}

export function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    client_id_metadata_document_supported: true,
  };
}

// ---------- Clients ----------

export class OAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

/** Redirect URIs must be https, or http on a loopback address (desktop/CLI clients). */
export function isAllowedRedirect(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

export type Client = { client_id: string; client_name: string; redirect_uris: string[]; client_secret_hash: string | null };

export async function registerClient(body: Record<string, unknown>) {
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string" && isAllowedRedirect(u))) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must be https URLs (or http://localhost)");
  }
  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : "";
  const method = body.token_endpoint_auth_method;
  const confidential = method === "client_secret_post" || method === "client_secret_basic";
  const clientId = "fbc_" + randomBytes(16).toString("base64url");
  const secret = confidential ? token("fbcs_") : null;
  await db()`
    insert into oauth_clients (client_id, client_name, redirect_uris, client_secret_hash)
    values (${clientId}, ${name}, ${uris as string[]}, ${secret ? sha256(secret) : null})`;
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: name,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: confidential ? method : "none",
    scope: SCOPE,
  };
}

const cimdCache = new Map<string, { client: Client; at: number }>();

/** Client ID Metadata Document: the client_id is an https URL that serves the client's metadata. */
async function fetchMetadataClient(clientId: string): Promise<Client> {
  const cached = cimdCache.get(clientId);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.client;
  const u = new URL(clientId);
  const devLoopback = process.env.NODE_ENV !== "production" && u.protocol === "http:" && u.hostname === "localhost";
  if (u.protocol !== "https:" && !devLoopback) throw new OAuthError("invalid_client", "client_id URL must be https");
  const res = await fetch(clientId, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" }, redirect: "error" });
  if (!res.ok) throw new OAuthError("invalid_client", `Couldn't fetch client metadata (${res.status})`);
  const text = await res.text();
  if (text.length > 20_000) throw new OAuthError("invalid_client", "Client metadata too large");
  const doc = JSON.parse(text) as { client_id?: string; client_name?: string; redirect_uris?: unknown };
  if (doc.client_id !== clientId) throw new OAuthError("invalid_client", "client_id in metadata doesn't match its URL");
  const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((x): x is string => typeof x === "string" && isAllowedRedirect(x)) : [];
  if (uris.length === 0) throw new OAuthError("invalid_client", "Client metadata has no usable redirect_uris");
  const client: Client = { client_id: clientId, client_name: String(doc.client_name ?? u.hostname).slice(0, 100), redirect_uris: uris, client_secret_hash: null };
  cimdCache.set(clientId, { client, at: Date.now() });
  return client;
}

export async function getClient(clientId: string): Promise<Client> {
  if (!clientId) throw new OAuthError("invalid_client", "client_id is required");
  if (/^https?:\/\//.test(clientId)) return fetchMetadataClient(clientId);
  const [c] = await db()<Client[]>`
    select client_id, client_name, redirect_uris, client_secret_hash from oauth_clients where client_id = ${clientId}`;
  if (!c) throw new OAuthError("invalid_client", "Unknown client");
  return c;
}

export type AuthorizeParams = {
  client: Client;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
};

/**
 * Validate an /authorize request. Errors here are shown on the page, never redirected,
 * because an unverified redirect_uri must not receive anything.
 */
export async function validateAuthorizeRequest(p: Record<string, string | undefined>): Promise<AuthorizeParams> {
  const client = await getClient(p.client_id ?? "");
  const redirectUri = p.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : "");
  if (!client.redirect_uris.includes(redirectUri)) throw new OAuthError("invalid_request", "redirect_uri isn't registered for this client");
  if (p.response_type !== "code") throw new OAuthError("unsupported_response_type", "Only response_type=code is supported");
  if (!p.code_challenge || p.code_challenge_method !== "S256") throw new OAuthError("invalid_request", "PKCE with S256 is required");
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge)) throw new OAuthError("invalid_request", "Malformed code_challenge");
  return { client, redirectUri, state: p.state ?? null, codeChallenge: p.code_challenge };
}

export async function issueCode(a: AuthorizeParams): Promise<string> {
  const code = token("fbac_");
  await db()`
    insert into oauth_codes (code_hash, client_id, redirect_uri, code_challenge, expires_at)
    values (${sha256(code)}, ${a.client.client_id}, ${a.redirectUri}, ${a.codeChallenge},
      now() + make_interval(secs => ${CODE_TTL_SECONDS}))`;
  return code;
}

export function redirectWith(uri: string, params: Record<string, string | null>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  return u.toString();
}

async function issueTokens(client: Client) {
  const access = token("fbat_");
  const refresh = token("fbrt_");
  await db()`
    insert into oauth_tokens (token_hash, kind, client_id, client_name, expires_at) values
      (${sha256(access)}, 'access', ${client.client_id}, ${client.client_name}, now() + make_interval(secs => ${ACCESS_TTL_SECONDS})),
      (${sha256(refresh)}, 'refresh', ${client.client_id}, ${client.client_name}, now() + make_interval(secs => ${REFRESH_TTL_SECONDS}))`;
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_SECONDS, refresh_token: refresh, scope: SCOPE };
}

function authenticateClient(client: Client, secret: string | null) {
  if (!client.client_secret_hash) return; // public client: PKCE is the proof
  if (!secret || !safeEqual(sha256(secret), client.client_secret_hash)) throw new OAuthError("invalid_client", "Client authentication failed", 401);
}

function b64urlSha256(s: string) {
  return createHash("sha256").update(s).digest("base64url");
}

/** Token endpoint logic. `form` holds the request parameters; `basic` is a decoded Basic auth pair if sent. */
export async function exchangeToken(form: Record<string, string>, basic: { id: string; secret: string } | null) {
  const clientId = basic?.id ?? form.client_id ?? "";
  const client = await getClient(clientId);
  authenticateClient(client, basic?.secret ?? form.client_secret ?? null);

  if (form.grant_type === "authorization_code") {
    const sql = db();
    const [c] = await sql<{ client_id: string; redirect_uri: string; code_challenge: string }[]>`
      update oauth_codes set used = true
      where code_hash = ${sha256(form.code ?? "")} and not used and expires_at > now()
      returning client_id, redirect_uri, code_challenge`;
    if (!c) throw new OAuthError("invalid_grant", "Code is invalid, expired, or already used");
    if (c.client_id !== client.client_id) throw new OAuthError("invalid_grant", "Code was issued to another client");
    if (form.redirect_uri && form.redirect_uri !== c.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri mismatch");
    if (!form.code_verifier || !safeEqual(b64urlSha256(form.code_verifier), c.code_challenge)) {
      throw new OAuthError("invalid_grant", "PKCE verification failed");
    }
    return issueTokens(client);
  }

  if (form.grant_type === "refresh_token") {
    const [t] = await db()<{ client_id: string }[]>`
      update oauth_tokens set revoked = true
      where token_hash = ${sha256(form.refresh_token ?? "")} and kind = 'refresh' and not revoked and expires_at > now()
      returning client_id`;
    if (!t || t.client_id !== client.client_id) throw new OAuthError("invalid_grant", "Refresh token is invalid or expired");
    return issueTokens(client);
  }

  throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

export async function revokeToken(tok: string) {
  await db()`update oauth_tokens set revoked = true where token_hash = ${sha256(tok)}`;
}

export async function revokeClient(clientId: string) {
  await db()`update oauth_tokens set revoked = true where client_id = ${clientId}`;
}

/** Check a bearer token for the MCP endpoint. Accepts OAuth access tokens, or MCP_API_KEY if set. */
export async function verifyBearer(header: string | null): Promise<{ clientId: string; clientName: string } | null> {
  const m = header?.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const tok = m[1].trim();
  const key = process.env.MCP_API_KEY;
  if (key && key.length >= 32 && safeEqual(tok, key)) return { clientId: "api-key", clientName: "API key" };
  const [t] = await db()<{ client_id: string; client_name: string }[]>`
    update oauth_tokens set last_used_at = now()
    where token_hash = ${sha256(tok)} and kind = 'access' and not revoked and expires_at > now()
    returning client_id, client_name`;
  return t ? { clientId: t.client_id, clientName: t.client_name } : null;
}

export async function connectedApps() {
  return db()<{ client_id: string; client_name: string; last_used_at: Date | null; first_seen: Date }[]>`
    select client_id, max(client_name) as client_name, max(last_used_at) as last_used_at, min(created_at) as first_seen
    from oauth_tokens where not revoked and expires_at > now()
    group by client_id order by max(created_at) desc`;
}

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id",
};
