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

`resolveOwner()` is the single swap point — see
[decision 0001](decisions/0001-native-github-oauth.md) for the Better Auth
deferral. Two implementations ship:

- **allowlist** (`KM_OWNER_AUTH=allowlist`, default without GitHub creds):
  operator-controlled `KM_HOSTED_BOOTSTRAP_EMAILS`. Demo/dev.
- **github** (auto-selected when `KM_GITHUB_CLIENT_ID` is set): standard
  OAuth web flow — `/authorize` without an owner session redirects to
  `/auth/github/start` → GitHub (CSRF state, 10m TTL, single-use) →
  `/auth/github/callback` exchanges the code and accepts **verified emails
  only** → 8h owner-session cookie (sha256 at rest). GitHub Enterprise /
  test endpoints injectable via `KM_GITHUB_BASE` / `KM_GITHUB_API`.

Everything downstream of the seam — codes, tokens, claims — is final.

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
- Device-authorization grant for headless boxes (threat-model principals)
- Per-identity rate budgets on `/mcp` itself
