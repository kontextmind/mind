/**
 * Owner-authentication seam (docs/hosted-auth.md, decision 0001).
 *
 * Two implementations behind one interface (`resolveOwner → email | null`):
 *  - allowlist: operator-controlled KM_HOSTED_BOOTSTRAP_EMAILS (demo/dev)
 *  - github:    standard OAuth web flow — CSRF-state redirect to GitHub,
 *               code exchange, verified-primary-email resolution, 8h
 *               owner-session cookie (hashed at rest)
 *
 * GitHub Enterprise / test endpoints are injectable (KM_GITHUB_BASE/API) —
 * that injectability is what keeps this flow hermetically testable.
 * Everything downstream of the seam (codes, tokens, claims) is final.
 */
import { createHash, randomBytes } from "node:crypto";
import { adminDb } from "./db";
import { canonicalResource, type Config } from "./config";

export const OWNER_COOKIE = "km_own";
const OWNER_TTL_S = 8 * 3600;
const STATE_TTL_S = 600;

export interface OwnerAuth {
  email: string;
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function cookieOf(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.split("=");
    if (k?.trim() === name) return rest.join("=").trim();
  }
  return null;
}

/** The seam. Returns the authenticated owner's email, or null. */
export async function resolveOwner(cfg: Config, req: Request): Promise<OwnerAuth | null> {
  if (cfg.ownerAuth === "github") {
    const token = cookieOf(req, OWNER_COOKIE);
    if (!token) return null;
    const sql = adminDb();
    const rows = await sql`
      select email from oauth_owner_sessions
      where token_hash = ${sha(token)} and expires_at > now()`;
    if (rows.length === 0) return null;
    return { email: String(rows[0].email) };
  }
  // allowlist: operator-controlled emails (demo/dev seam)
  const email = new URL(req.url).searchParams.get("email")?.trim().toLowerCase() ?? "";
  if (!email || !cfg.bootstrapEmails.includes(email)) return null;
  return { email };
}

/** Step 1: stash CSRF state, send the owner to GitHub. */
export async function startGitHubLogin(cfg: Config, req: Request): Promise<Response> {
  if (cfg.ownerAuth !== "github" || !cfg.github) {
    return Response.json({ error: "owner_auth_not_configured" }, { status: 503 });
  }
  const returnTo = new URL(req.url).searchParams.get("return") ?? "";
  if (!returnTo.startsWith("/authorize")) {
    return Response.json({ error: "invalid_return" }, { status: 400 });
  }
  const state = `gst_${randomBytes(16).toString("hex")}`;
  const sql = adminDb();
  await sql`insert into oauth_states (state, return_to, expires_at)
    values (${state}, ${returnTo}, now() + make_interval(secs => ${STATE_TTL_S}))`;
  const issuer = canonicalResource(cfg);
  const to = new URL(`${cfg.github.base}/login/oauth/authorize`);
  to.searchParams.set("client_id", cfg.github.clientId);
  to.searchParams.set("redirect_uri", `${issuer}/auth/github/callback`);
  to.searchParams.set("state", state);
  to.searchParams.set("scope", "read:user user:email");
  return Response.redirect(to.toString(), 302);
}

/** Step 2: GitHub sent the owner back — verify state, exchange code, login. */
export async function githubCallback(cfg: Config, req: Request): Promise<Response> {
  if (cfg.ownerAuth !== "github" || !cfg.github) {
    return Response.json({ error: "owner_auth_not_configured" }, { status: 503 });
  }
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const sql = adminDb();

  // State is single-use: consumed BEFORE anything else happens.
  const consumed = state
    ? await sql`delete from oauth_states where state = ${state} and expires_at > now()
        returning return_to`
    : [];
  if (consumed.length === 0) {
    return Response.json({ error: "invalid_state" }, { status: 400 });
  }
  const returnTo = String(consumed[0].return_to);

  const gh = cfg.github;
  const tokenRes = await fetch(`${gh.base}/login/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: gh.clientId, client_secret: gh.clientSecret, code }),
  });
  const tokenBody = (await tokenRes.json().catch(() => null)) as { access_token?: string } | null;
  if (!tokenBody?.access_token) {
    return Response.json({ error: "github_token_exchange_failed" }, { status: 502 });
  }
  const accessToken = tokenBody.access_token;

  const email = await verifiedPrimaryEmail(gh.api, accessToken);
  if (!email) {
    return Response.json(
      { error: "no_verified_email", detail: "GitHub account has no verified email" },
      { status: 403 },
    );
  }

  const token = `km_own_${randomBytes(24).toString("hex")}`;
  await sql`insert into oauth_owner_sessions (token_hash, email, expires_at)
    values (${sha(token)}, ${email}, now() + make_interval(secs => ${OWNER_TTL_S}))`;

  const secure = canonicalResource(cfg).startsWith("https://");
  const issuer = canonicalResource(cfg);
  return new Response(null, {
    status: 302,
    headers: {
      location: `${issuer}${returnTo}`,
      "set-cookie": `${OWNER_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${OWNER_TTL_S}${secure ? "; Secure" : ""}`,
    },
  });
}

/** Verified primary email first; any verified email as fallback. Unverified
 * addresses are never accepted — identity is the trust anchor here. */
async function verifiedPrimaryEmail(api: string, accessToken: string): Promise<string | null> {
  const headers = { authorization: `Bearer ${accessToken}`, accept: "application/json" };
  const emailsRes = await fetch(`${api}/user/emails`, { headers }).catch(() => null);
  const emails = (await emailsRes?.json().catch(() => null)) as
    | Array<{ email: string; primary?: boolean; verified?: boolean }>
    | null;
  const verified = (emails ?? []).filter((e) => e.verified);
  const primary = verified.find((e) => e.primary);
  return (primary?.email ?? verified[0]?.email ?? "").toLowerCase() || null;
}
