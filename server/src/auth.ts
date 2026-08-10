/**
 * Auth boundary (docs/threat-model.md B1).
 *  - demo: static bearer token, localhost binding enforced by the caller.
 *  - hosted: OAuth 2.1 bearer tokens (auth-server.ts) — audience-bound,
 *    resolved server-side into claims (never client-supplied, B2). 401s
 *    carry RFC 9728 WWW-Authenticate.
 */
import type { Config } from "./config";
import { DEMO_NAMESPACE, DEMO_ORG, DEMO_USER } from "./config";
import { resolveAccessToken } from "./auth-server";
import type { KmClaims } from "./db";

export type AuthResult =
  | { ok: true; claims: KmClaims }
  | { ok: false; status: number; body: unknown; headers?: Record<string, string> };

export async function authenticate(cfg: Config, req: Request): Promise<AuthResult> {
  const auth = req.headers.get("authorization");

  if (cfg.mode === "hosted") {
    const wwwAuth = (error?: string, description?: string) => {
      const base = 'Bearer resource_metadata="/.well-known/oauth-protected-resource"';
      if (!error) return base;
      return `${base}, error="${error}"${description ? `, error_description="${description}"` : ""}`;
    };
    if (!auth || !auth.startsWith("Bearer ")) {
      return {
        ok: false,
        status: 401,
        body: { error: "missing_token" },
        headers: { "WWW-Authenticate": wwwAuth() },
      };
    }
    const resolved = await resolveAccessToken(cfg, auth.slice(7));
    if (!resolved.ok) {
      return {
        ok: false,
        status: 401,
        body: { error: resolved.error },
        headers: { "WWW-Authenticate": wwwAuth("invalid_token", resolved.error) },
      };
    }
    return { ok: true, claims: resolved.claims };
  }

  // demo mode
  if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== cfg.demoToken) {
    return { ok: false, status: 401, body: { error: "invalid_demo_token" } };
  }
  return {
    ok: true,
    claims: {
      sub: DEMO_USER,
      kind: "human",
      org: DEMO_ORG,
      namespaces: [DEMO_NAMESPACE],
      roles: { [DEMO_NAMESPACE]: "owner" },
    },
  };
}
