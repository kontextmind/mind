/**
 * Device-authorization grant (RFC 8628) — the headless-box principal
 * (docs/threat-model.md). A box with no browser gets a device_code; a human
 * approves the user_code through the hosted UI (owner-authenticated via the
 * seam); the box polls /token until approved.
 *
 * Polling contract: too-fast → slow_down (interval +5s), not yet approved →
 * authorization_pending, denied → access_denied, TTL (15m) → expired_token.
 * The device_code never touches the human's browser; the user_code never
 * authorizes anything on its own (owner approval is the gate).
 */
import { randomBytes } from "node:crypto";
import { adminDb } from "./db";
import { canonicalResource, type Config } from "./config";
import { resolveOwner } from "./owner-auth";

export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const DEVICE_TTL_S = 900;
export const DEVICE_INTERVAL_S = 5;

/** Unambiguous alphabet (no 0/O, 1/I/L) — humans type this. */
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";

export function newUserCode(): string {
  let out = "";
  const bytes = randomBytes(8);
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

const json400 = (error: string, detail?: string) =>
  Response.json({ error, ...(detail ? { error_description: detail } : {}) }, { status: 400 });

async function readBody(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const j = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    return Object.fromEntries(Object.entries(j ?? {}).map(([k, v]) => [k, String(v)]));
  }
  const form = new URLSearchParams(await req.text());
  return Object.fromEntries(form.entries());
}

/** POST /device_authorization — the box starts here. */
export async function deviceAuthorization(cfg: Config, req: Request): Promise<Response> {
  const body = await readBody(req);
  const issuer = canonicalResource(cfg);
  const clientId = body.client_id ?? "";
  const sql = adminDb();
  const clients = clientId
    ? await sql`select client_id from oauth_clients where client_id = ${clientId}`
    : [];
  if (clients.length === 0) return json400("invalid_client", "unknown client_id");
  const resource = body.resource || issuer;
  if (resource !== issuer) return json400("invalid_target", "resource must be this server");

  const deviceCode = `dvc_${randomBytes(24).toString("hex")}`;
  const userCode = newUserCode();
  await sql`insert into oauth_device_grants (device_code, user_code, client_id, resource, expires_at)
    values (${deviceCode}, ${userCode}, ${clientId}, ${resource},
            now() + make_interval(secs => ${DEVICE_TTL_S}))`;
  return Response.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${issuer}/device`,
    verification_uri_complete: `${issuer}/device?user_code=${userCode}`,
    expires_in: DEVICE_TTL_S,
    interval: DEVICE_INTERVAL_S,
  });
}

/** GET /device — the human approval page (owner session required). */
export async function devicePage(cfg: Config, req: Request): Promise<Response> {
  const owner = await resolveOwner(cfg, req);
  if (!owner) {
    if (cfg.ownerAuth === "github") {
      return Response.redirect("/auth/github/start?return=%2Fdevice", 302);
    }
    return Response.json({ error: "access_denied" }, { status: 403 });
  }
  const prefill = new URL(req.url).searchParams.get("user_code") ?? "";
  const html = `<!doctype html>
<html><head><title>KontextMind — device approval</title></head>
<body style="font-family:system-ui;max-width:32em;margin:4em auto">
<h2>Approve a device</h2>
<p>Signed in as <b>${owner.email}</b>. Enter the code your device shows.</p>
<form method="post" action="/device/approve">
  <input name="user_code" value="${prefill.replace(/[^A-Z0-9-]/g, "")}"
         placeholder="XXXX-XXXX" required
         style="font-size:1.4em;letter-spacing:.1em;padding:.3em">
  <button type="submit">Approve</button>
</form>
<form method="post" action="/device/deny">
  <input type="hidden" name="user_code" value="${prefill.replace(/[^A-Z0-9-]/g, "")}">
  <button type="submit" style="color:#900">Deny</button>
</form>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function setVerdict(
  cfg: Config,
  req: Request,
  verdict: "approved" | "denied",
): Promise<Response> {
  const owner = await resolveOwner(cfg, req);
  if (!owner) return Response.json({ error: "access_denied" }, { status: 403 });
  const body = await readBody(req);
  const userCode = (body.user_code ?? "").toUpperCase().trim();
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode)) {
    return json400("invalid_request", "user_code must look like XXXX-XXXX");
  }
  const sql = adminDb();
  const upd = await sql`
    update oauth_device_grants
    set status = ${verdict}, approved_by = ${owner.email}
    where user_code = ${userCode} and status = 'pending' and expires_at > now()
    returning device_code`;
  if (upd.length === 0) return json400("invalid_request", "no pending grant for that code");
  return Response.json({ ok: true, verdict });
}

export const deviceApprove = (cfg: Config, req: Request) => setVerdict(cfg, req, "approved");
export const deviceDeny = (cfg: Config, req: Request) => setVerdict(cfg, req, "denied");
