/**
 * kontext login — OAuth login for the CLI via the device-authorization
 * grant (RFC 8628, docs/hosted-auth.md). Headless by design: the CLI shows a
 * code, a human approves it in a browser, tokens land on disk.
 *
 * Precedence: KM_TOKEN env > saved tokens (auto-refreshed) > none.
 * Storage: $KM_CONFIG_DIR ?? ~/.kontextmind, keyed per server host.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export function configDir(): string {
  return process.env.KM_CONFIG_DIR ?? join(homedir(), ".kontextmind");
}

function hostKey(url: string): string {
  const u = new URL(url.replace(/\/mcp\/?$/, ""));
  return createHash("sha256").update(u.origin).digest("hex").slice(0, 12);
}

function pathsFor(url: string): { client: string; tokens: string } {
  const k = hostKey(url);
  return { client: join(configDir(), `client-${k}.json`), tokens: join(configDir(), `tokens-${k}.json`) };
}

function baseOf(mcpUrl: string): string {
  return mcpUrl.replace(/\/mcp\/?$/, "");
}

async function postForm(url: string, fields: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

/** DCR once per server; the client_id is reused on every later login. */
async function ensureClient(baseUrl: string, clientPath: string): Promise<string> {
  if (existsSync(clientPath)) {
    return (JSON.parse(readFileSync(clientPath, "utf8")) as { client_id: string }).client_id;
  }
  const res = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "kontext-cli",
      redirect_uris: ["http://localhost:0/device"], // unused for device flow; DCR requires one
    }),
  });
  if (res.status !== 201) throw new Error(`registration failed: ${res.status}`);
  const body = (await res.json()) as { client_id: string };
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(clientPath, `${JSON.stringify(body, null, 2)}\n`);
  return body.client_id;
}

/** Run the device flow interactively. Resolves when the human approves. */
export async function login(mcpUrl: string): Promise<{ access_token: string }> {
  const base = baseOf(mcpUrl);
  const { client: clientPath, tokens: tokensPath } = pathsFor(mcpUrl);
  const clientId = await ensureClient(base, clientPath);

  const da = await postForm(`${base}/device_authorization`, { client_id: clientId });
  if (da.status !== 200) throw new Error(`device_authorization failed: ${da.status}`);
  const grant = (await da.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };

  console.log(`\n  Open:  ${grant.verification_uri}`);
  console.log(`  Code:  ${grant.user_code}\n`);
  console.log("Waiting for approval…");

  const deadline = Date.now() + grant.expires_in * 1000;
  let interval = Math.max(grant.interval, 1) * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("login timed out (grant expired)");
    await new Promise((r) => setTimeout(r, interval));
    const res = await postForm(`${base}/token`, {
      grant_type: DEVICE_GRANT_TYPE,
      device_code: grant.device_code,
      client_id: clientId,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 200) {
      const tokens = body as { access_token: string; refresh_token: string; expires_in: number };
      writeFileSync(
        tokensPath,
        `${JSON.stringify(
          { ...tokens, expires_at: Date.now() + tokens.expires_in * 1000 },
          null,
          2,
        )}\n`,
      );
      console.log("Logged in. Tokens saved.");
      return tokens;
    }
    const err = String(body.error ?? "");
    if (err === "authorization_pending") continue;
    if (err === "slow_down") {
      interval += 5000;
      continue;
    }
    throw new Error(`login failed: ${err}`);
  }
}

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

/** KM_TOKEN env wins; else stored tokens, auto-refreshed past expiry. */
export async function getAuth(mcpUrl: string): Promise<string | null> {
  if (process.env.KM_TOKEN) return process.env.KM_TOKEN;
  const { client: clientPath, tokens: tokensPath } = pathsFor(mcpUrl);
  if (!existsSync(tokensPath)) return null;
  const stored = JSON.parse(readFileSync(tokensPath, "utf8")) as StoredTokens;
  // Refresh 60s before actual expiry to dodge clock-edge 401s mid-call.
  if (Date.now() < stored.expires_at - 60_000) return stored.access_token;

  if (!existsSync(clientPath)) return null;
  const clientId = (JSON.parse(readFileSync(clientPath, "utf8")) as { client_id: string }).client_id;
  const res = await postForm(`${baseOf(mcpUrl)}/token`, {
    grant_type: "refresh_token",
    refresh_token: stored.refresh_token,
    client_id: clientId,
  });
  if (res.status !== 200) return null; // dead session: caller falls back / re-logins
  const fresh = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  writeFileSync(
    tokensPath,
    `${JSON.stringify(
      { ...fresh, expires_at: Date.now() + fresh.expires_in * 1000 },
      null,
      2,
    )}\n`,
  );
  return fresh.access_token;
}
