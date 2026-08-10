# Hosted Auth (OAuth 2.1)

Status: **v1 (machine surface frozen)** · threat-model B1/B2

Hosted mode (`KM_MODE=hosted`) serves the MCP authorization spec: OAuth 2.1
with PKCE, dynamic client registration, and RFC 8707 audience-bound tokens.

## Surface

| Endpoint | What |
|---|---|
| `/.well-known/oauth-protected-resource` | RFC 9728 metadata |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata (S256 only) |
| `POST /register` | DCR (RFC 7591) — public clients, loopback/https redirects only |
| `GET /authorize` | authorization code + PKCE S256 + `resource` binding, 60s one-time codes |
| `POST /token` | code exchange; rotating refresh tokens (30d), 1h access tokens |

All auth endpoints are rate-limited per IP (`KM_AUTH_RATE_LIMIT`, default
120/min) and size-capped (B1).

## Owner authentication seam

`authenticateOwner()` is the single swap point. **v1:** operator-controlled
allowlist (`KM_HOSTED_BOOTSTRAP_EMAILS`). **Production:** GitHub OAuth
session via Better Auth (README decision). Everything downstream of the seam
— codes, tokens, claims — is final and does not change with the IdP.

First login bootstraps the tenant: user + org (owner membership) + `default`
namespace.

## Trust lane (B2)

- `oauth_clients` / `oauth_codes` / `oauth_tokens` / `users` are RLS
  **deny-all** for `km_app`; only the admin lane touches them.
- Token plaintext is never stored (SHA-256 hash only).
- Claims are constructed server-side at token resolution from
  `memberships`/`namespaces` — never client-supplied, never carried in the
  token itself (opaque tokens).
- Every token is audience-bound to `KM_PUBLIC_URL` (canonical resource);
  a token presented with the wrong `resource` is rejected at issuance and
  again at resolution.

## Not yet

- Consent screen UI (v1 authorizes directly after owner authentication)
- GitHub OAuth upstream (the seam above)
- Device-authorization grant for headless boxes (threat-model principals)
- Per-identity rate budgets on `/mcp` itself
