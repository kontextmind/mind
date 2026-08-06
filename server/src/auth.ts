/**
 * Auth boundary (docs/threat-model.md B1).
 *  - demo: static bearer token, localhost binding enforced by the caller.
 *  - hosted: OAuth 2.1 + DCR lands in 1b; until then the correct 401 shape
 *    with RFC 9728 WWW-Authenticate is returned (never demo auth).
 */
import type { Config } from "./config";
import { DEMO_NAMESPACE, DEMO_ORG, DEMO_USER } from "./config";
import type { KmClaims } from "./db";

export type AuthResult =
  | { ok: true; claims: KmClaims }
  | { ok: false; status: number; body: unknown; headers?: Record<string, string> };

export function authenticate(cfg: Config, req: Request): AuthResult {
  const auth = req.headers.get("authorization");

  if (cfg.mode === "hosted") {
    return {
      ok: false,
      status: 401,
      body: { error: "hosted_auth_not_implemented", detail: "OAuth 2.1 + DCR lands in phase 1b" },
      headers: {
        "WWW-Authenticate":
          'Bearer resource_metadata="/.well-known/oauth-protected-resource"',
      },
    };
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
