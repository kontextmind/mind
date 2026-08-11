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

## Consent

Authorization requires consent, shown **once per (client, owner)** and
remembered (`oauth_consents`):

1. `/authorize` with an authenticated owner but no consent renders the
   consent screen (client name + identity); the request parks in
   `oauth_pending_authz` (one-time, 60s).
2. `POST /authorize/approve` records consent, mints the code, redirects.
   `POST /authorize/deny` redirects with `error=access_denied`.
3. A pending request can only be resolved by the identity it was
   authenticated as; foreign attempts consume it without approving.

`KM_AUTO_CONSENT=1` skips the screen (dev/test only). No code is ever
issued before consent.

## Device-authorization grant (RFC 8628)

Headless boxes (threat-model principal) have no browser:

1. Box: `POST /device_authorization` (client_id + resource) → `device_code`,
   `user_code` (`XXXX-XXXX`, unambiguous alphabet), `verification_uri`,
   15m TTL, 5s polling interval.
2. Human: `GET /device` (owner-authenticated) → enters the code →
   `POST /device/approve` (or `/device/deny`).
3. Box polls `POST /token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`:
   `authorization_pending` / `slow_down` (interval grows +5s per RFC) /
   `access_denied` / `expired_token` / tokens — minted once, consumed
   atomically, audience-bound like code-flow tokens.

The device code never touches the browser; the user code alone authorizes
nothing — the owner verdict is the gate. Approval bootstraps the tenant at
token issuance (the box's human may never visit `/authorize`).

## Not yet

- Per-harness emitters (Claude Code, Codex, …) — the generic commit-msg
  hook installed by `kontext init` already covers every harness
- Consent revocation UI (delete from `oauth_consents` revokes today)
