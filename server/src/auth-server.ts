/**
 * Hosted-mode OAuth 2.1 authorization server (docs/threat-model.md B1,
 * MCP authorization spec): protected-resource metadata, AS metadata, DCR,
 * authorization-code + PKCE (S256 only), RFC 8707 audience binding,
 * rotating refresh tokens, rate limiting.
 *
 * Owner-authentication seam: `authenticateOwner()` currently checks the
 * operator-controlled KM_HOSTED_BOOTSTRAP_EMAILS allowlist. Production swaps
 * this seam for GitHub OAuth via Better Auth (README decision) — everything
 * downstream of the seam (codes, tokens, claims) is final.
 *
 * Trust lane: clients/codes/tokens live in deny-all RLS tables; only the
 * admin lane touches them. Claims are constructed here at token resolution —
 * never client-supplied (B2).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { adminDb } from "./db";
import { canonicalResource, type Config } from "./config";
import { resolveOwner } from "./owner-auth";
import { DEVICE_GRANT_TYPE } from "./device-grant";
import type { KmClaims } from "./db";

export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 86400;
const CODE_TTL_S = 60;
const MAX_BODY = 64 * 1024;

// ---------------------------------------------------------------------------
// Rate limiting (B1): fixed 60s window per IP on the auth endpoints.
// ---------------------------------------------------------------------------

const windows = new Map<string, { start: number; count: number }>();

export function rateLimited(ip: string, limit: number): boolean {
  const now = Date.now();
  const w = windows.get(ip);
  if (!w || now - w.start > 60_000) {
    windows.set(ip, { start: now, count: 1 });
    return false;
  }
  w.count += 1;
  return w.count > limit;
}

function ipOf(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

function guarded(cfg: Config, req: Request): Response | null {
  if (rateLimited(ipOf(req), cfg.authRateLimit)) {
    return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  return null;
}

const json400 = (error: string, detail?: string) =>
  Response.json({ error, ...(detail ? { detail } : {}) }, { status: 400 });

// ---------------------------------------------------------------------------
// Discovery (RFC 9728 / RFC 8414)
// ---------------------------------------------------------------------------

export function protectedResourceMetadata(cfg: Config): Response {
  const issuer = canonicalResource(cfg);
  return Response.json({
    resource: issuer,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
  });
}

export function authorizationServerMetadata(cfg: Config): Response {
  const issuer = canonicalResource(cfg);
  return Response.json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    device_authorization_endpoint: `${issuer}/device_authorization`,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token", DEVICE_GRANT_TYPE],
    response_types_supported: ["code"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

function validRedirectUri(u: string): boolean {
  try {
    const p = new URL(u);
    if (p.protocol === "https:") return true;
    // Loopback http is allowed for native/CLI clients (OAuth 2.1 §7.3).
    return p.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(p.hostname);
  } catch {
    return false;
  }
}

export async function registerClient(req: Request, cfg: Config): Promise<Response> {
  const g = guarded(cfg, req);
  if (g) return g;
  const body = await readJson(req);
  if (!body) return json400("invalid_request", "unparseable body");
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return json400("invalid_redirect_uri", "redirect_uris required");
  }
  for (const u of redirectUris) {
    if (typeof u !== "string" || !validRedirectUri(u)) {
      return json400("invalid_redirect_uri", `rejected: ${String(u)}`);
    }
  }
  const clientId = `kmc_${randomBytes(12).toString("hex")}`;
  const sql = adminDb();
  await sql`insert into oauth_clients (client_id, client_name, redirect_uris)
    values (${clientId}, ${typeof body.client_name === "string" ? body.client_name : null},
            ${sql.json(redirectUris)})`;
  return Response.json({
    client_id: clientId,
    client_name: (body.client_name as string | null) ?? null,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    code_challenge_method: "S256",
  }, { status: 201 });
}

// ---------------------------------------------------------------------------
// Authorization endpoint (code + PKCE + audience binding)
// Owner authentication lives behind the seam in owner-auth.ts (decision 0001).
// ---------------------------------------------------------------------------

/** First login bootstraps the tenant: user + org + owner membership + namespace. */
async function bootstrapUser(email: string): Promise<string> {
  const sql = adminDb();
  const existing = await sql`select id from users where email = ${email}`;
  if (existing.length > 0) return existing[0].id as string;

  const userId = `user_${randomBytes(12).toString("hex")}`;
  const orgId = `org_${randomBytes(12).toString("hex")}`;
  const nsId = `ns_${randomBytes(12).toString("hex")}`;
  const slug = email.split("@")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24) || "user";
  await sql`insert into users (id, email) values (${userId}, ${email})`;
  await sql`insert into orgs (id, slug, name, trust_mode) values
    (${orgId}, ${`${slug}-${userId.slice(-4)}`}, ${email}, 'standard')`;
  await sql`insert into memberships (id, org_id, user_id, role) values
    (${`mem_${randomBytes(12).toString("hex")}`}, ${orgId}, ${userId}, 'owner')`;
  await sql`insert into namespaces (id, org_id, slug, kind) values
    (${nsId}, ${orgId}, 'default', 'project')`;
  return userId;
}

export async function authorize(req: Request, cfg: Config): Promise<Response> {
  const g = guarded(cfg, req);
  if (g) return g;
  const url = new URL(req.url);
  const q = url.searchParams;
  const issuer = canonicalResource(cfg);

  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";
  const sql = adminDb();

  // Client validation happens BEFORE any redirect decision.
  const clients = clientId
    ? await sql`select redirect_uris from oauth_clients where client_id = ${clientId}`
    : [];
  if (clients.length === 0) return json400("unauthorized_client", "unknown client_id");
  const registered = (clients[0].redirect_uris as unknown as string[]) ?? [];
  if (!redirectUri || !registered.includes(redirectUri)) {
    return json400("invalid_request", "redirect_uri not registered for client");
  }
  const fail = (error: string) => {
    const back = new URL(redirectUri);
    back.searchParams.set("error", error);
    const state = q.get("state");
    if (state) back.searchParams.set("state", state);
    return Response.redirect(back.toString(), 302);
  };

  if (q.get("response_type") !== "code") return fail("unsupported_response_type");
  const challenge = q.get("code_challenge") ?? "";
  if (!challenge || q.get("code_challenge_method") !== "S256") {
    return fail("invalid_request"); // OAuth 2.1: PKCE S256 is mandatory
  }
  const resource = q.get("resource") ?? "";
  if (resource !== issuer) return fail("invalid_target"); // RFC 8707 audience

  const owner = await resolveOwner(cfg, req);
  if (!owner) {
    if (cfg.ownerAuth === "github") {
      // Send the owner to GitHub; the state table carries us back here.
      const ret = `${url.pathname}?${url.searchParams.toString()}`;
      return Response.redirect(`/auth/github/start?return=${encodeURIComponent(ret)}`, 302);
    }
    // Direct 403 (not a redirect): no authenticated owner, nothing to send
    // back to the client — and the email itself must not leak via redirect.
    return Response.json(
      { error: "access_denied", detail: "owner authentication failed (allowlist)" },
      { status: 403 },
    );
  }
  const userId = await bootstrapUser(owner.email);

  const code = `oc_${randomBytes(24).toString("hex")}`;
  await sql`insert into oauth_codes (code, client_id, user_id, redirect_uri, challenge, resource, expires_at)
    values (${code}, ${clientId}, ${userId}, ${redirectUri}, ${challenge}, ${resource},
            now() + make_interval(secs => ${CODE_TTL_S}))`;

  const back = new URL(redirectUri);
  back.searchParams.set("code", code);
  const state = q.get("state");
  if (state) back.searchParams.set("state", state);
  return Response.redirect(back.toString(), 302);
}

// ---------------------------------------------------------------------------
// Token endpoint (code exchange + rotating refresh)
// ---------------------------------------------------------------------------

function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function readForm(req: Request): Promise<URLSearchParams | null> {
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try {
    return new URLSearchParams(text);
  } catch {
    return null;
  }
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function issueTokens(
  clientId: string,
  userId: string,
  audience: string,
): Promise<Record<string, unknown>> {
  const sql = adminDb();
  const access = `kmt_${randomBytes(24).toString("hex")}`;
  const refresh = `kmr_${randomBytes(24).toString("hex")}`;
  await sql`insert into oauth_tokens (token_hash, kind, client_id, user_id, audience, expires_at)
    values (${tokenHash(access)}, 'access', ${clientId}, ${userId}, ${audience},
            now() + make_interval(secs => ${ACCESS_TTL_S}))`;
  await sql`insert into oauth_tokens (token_hash, kind, client_id, user_id, audience, expires_at)
    values (${tokenHash(refresh)}, 'refresh', ${clientId}, ${userId}, ${audience},
            now() + make_interval(secs => ${REFRESH_TTL_S}))`;
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
  };
}

export async function token(req: Request, cfg: Config): Promise<Response> {
  const g = guarded(cfg, req);
  if (g) return g;
  const issuer = canonicalResource(cfg);
  const form = await readForm(req);
  if (!form) return json400("invalid_request", "body too large or unparseable");
  const grant = form.get("grant_type");
  const sql = adminDb();

  // Audience binding: the code grant must declare it; refresh and device
  // grants already carry it (stored token row / grant row) — RFC 8707 makes
  // `resource` optional on refresh, and repeating it must still match.
  const resource = form.get("resource");
  if (grant === "authorization_code" && resource !== issuer) {
    return Response.json({ error: "invalid_target" }, { status: 400 });
  }
  if (grant === "refresh_token" && resource !== null && resource !== issuer) {
    return Response.json({ error: "invalid_target" }, { status: 400 });
  }

  if (grant === DEVICE_GRANT_TYPE) {
    return deviceTokenPoll(cfg, form);
  }

  if (grant === "authorization_code") {
    const code = form.get("code") ?? "";
    const rows = code
      ? await sql`select * from oauth_codes where code = ${code}`
      : [];
    if (rows.length === 0) return Response.json({ error: "invalid_grant" }, { status: 400 });
    const row = rows[0];
    // One-time use is enforced BEFORE any other validation result leaks.
    const consumed = await sql`
      update oauth_codes set used_at = now()
      where code = ${code} and used_at is null and expires_at > now()
      returning code`;
    if (consumed.length === 0) return Response.json({ error: "invalid_grant" }, { status: 400 });
    if (
      row.client_id !== form.get("client_id") ||
      row.redirect_uri !== form.get("redirect_uri") ||
      row.resource !== issuer
    ) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    const verifier = form.get("code_verifier") ?? "";
    if (!verifier || !timingSafeEqualHex(s256(verifier), String(row.challenge))) {
      return Response.json({ error: "invalid_grant", detail: "PKCE verification failed" }, { status: 400 });
    }
    return Response.json(await issueTokens(String(row.client_id), String(row.user_id), issuer));
  }

  if (grant === "refresh_token") {
    const refreshToken = form.get("refresh_token") ?? "";
    const rows = refreshToken
      ? await sql`select * from oauth_tokens
          where token_hash = ${tokenHash(refreshToken)} and kind = 'refresh'`
      : [];
    if (rows.length === 0) return Response.json({ error: "invalid_grant" }, { status: 400 });
    const row = rows[0];
    // Rotation: the old refresh token is revoked atomically with issuance.
    const revoked = await sql`
      update oauth_tokens set revoked_at = now()
      where token_hash = ${tokenHash(refreshToken)} and revoked_at is null and expires_at > now()
      returning token_hash`;
    if (revoked.length === 0) return Response.json({ error: "invalid_grant" }, { status: 400 });
    if (row.client_id !== form.get("client_id")) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    // New pair inherits the old token's audience.
    return Response.json(
      await issueTokens(String(row.client_id), String(row.user_id), String(row.audience)),
    );
  }

  return json400("unsupported_grant_type");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * RFC 8628 polling leg. The box repeats this; the grant's verdict (set by the
 * owner through /device) decides the outcome: too-fast → slow_down (interval
 * grows +5s per RFC), pending → authorization_pending, tokens are minted
 * once on approval (consumed atomically).
 */
async function deviceTokenPoll(cfg: Config, form: URLSearchParams): Promise<Response> {
  const sql = adminDb();
  const deviceCode = form.get("device_code") ?? "";
  const rows = deviceCode
    ? await sql`select * from oauth_device_grants where device_code = ${deviceCode}`
    : [];
  if (rows.length === 0) return Response.json({ error: "invalid_grant" }, { status: 400 });
  const g = rows[0];
  if ((g.expires_at as Date) <= new Date()) {
    return Response.json({ error: "expired_token" }, { status: 400 });
  }
  if (g.status === "denied") return Response.json({ error: "access_denied" }, { status: 400 });
  if (g.status === "consumed") return Response.json({ error: "invalid_grant" }, { status: 400 });
  if (g.status === "pending") {
    const intervalMs = Number(g.interval_s) * 1000;
    if (g.last_poll && Date.now() - (g.last_poll as Date).getTime() < intervalMs) {
      await sql`update oauth_device_grants set interval_s = interval_s + 5
        where device_code = ${deviceCode}`;
      return Response.json({ error: "slow_down" }, { status: 400 });
    }
    await sql`update oauth_device_grants set last_poll = now() where device_code = ${deviceCode}`;
    return Response.json({ error: "authorization_pending" }, { status: 400 });
  }
  // approved → consume atomically, then mint audience-bound tokens for the
  // approving owner. Approval recorded intent; token issuance bootstraps the
  // tenant (the headless box's human may never visit /authorize themselves).
  if (g.client_id !== form.get("client_id")) {
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  }
  const taken = await sql`
    update oauth_device_grants set status = 'consumed'
    where device_code = ${deviceCode} and status = 'approved'
    returning approved_by, resource`;
  if (taken.length === 0) return Response.json({ error: "invalid_grant" }, { status: 400 });
  const userId = await bootstrapUser(String(taken[0].approved_by));
  return Response.json(await issueTokens(String(g.client_id), userId, String(taken[0].resource)));
}

// ---------------------------------------------------------------------------
// Token → claims (B2: claims constructed server-side at resolution)
// ---------------------------------------------------------------------------

export async function resolveAccessToken(
  cfg: Config,
  bearer: string,
): Promise<{ ok: true; claims: KmClaims; userId: string } | { ok: false; error: string }> {
  const issuer = canonicalResource(cfg);
  const sql = adminDb();
  const rows = await sql`
    select user_id, audience, expires_at, revoked_at from oauth_tokens
    where token_hash = ${tokenHash(bearer)} and kind = 'access'`;
  if (rows.length === 0) return { ok: false, error: "invalid_token" };
  const row = rows[0];
  if (row.revoked_at || (row.expires_at as Date) <= new Date()) {
    return { ok: false, error: "expired_token" };
  }
  if (row.audience !== issuer) return { ok: false, error: "invalid_audience" };

  const userId = String(row.user_id);
  const mems = await sql`
    select org_id, role from memberships where user_id = ${userId}
    order by created_at limit 1`;
  if (mems.length === 0) return { ok: false, error: "no_membership" };
  const orgId = String(mems[0].org_id);
  const nsRows = await sql`
    select id from namespaces where org_id = ${orgId} order by slug`;
  const namespaces = nsRows.map((r) => String(r.id));
  return {
    ok: true,
    userId,
    claims: {
      sub: userId,
      kind: "human",
      org: orgId,
      namespaces,
      roles: Object.fromEntries(namespaces.map((ns) => [ns, String(mems[0].role) as "owner"])),
    },
  };
}
