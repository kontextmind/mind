# Decision 0001 — Native GitHub OAuth at the owner seam (Better Auth deferred)

Status: **accepted** · supersedes the README plan note ("Better Auth: GitHub
OAuth") for the phase-1 horizon.

## Context

Hosted mode needs an owner-identity provider behind the `authenticateOwner`
seam (docs/hosted-auth.md). The README plan names Better Auth. Evaluation
(2026-08):

- Better Auth ships **no postgres.js adapter** (bundled: drizzle, kysely,
  prisma, mongodb, memory). Adoption means a parallel query stack (kysely/pg)
  and Better Auth's own `user/session/account/verification` tables alongside
  ours.
- Its GitHub social flow targets github.com directly; a hermetic CI (no
  credentials, no network to GitHub) would need fragile fetch interception.
- Everything downstream of the seam — codes, tokens, claims, RLS — is already
  built and test-covered. The seam exists precisely so the IdP can move.

## Decision

Implement the GitHub OAuth web flow **natively at the seam** (~150 lines,
zero new dependencies), selected by config:

- `KM_OWNER_AUTH=allowlist` (default, and the only mode in demo) — operator
  email allowlist, unchanged.
- `KM_OWNER_AUTH=github` (+ `KM_GITHUB_CLIENT_ID/SECRET`) — standard
  authorization-code flow with CSRF state, verified-primary-email resolution,
  and an 8h owner-session cookie. GitHub Enterprise/test endpoints are
  injectable (`KM_GITHUB_BASE`, `KM_GITHUB_API`), which is what makes the
  flow hermetically testable (mock GitHub server in CI).

## Consequences

- The MCP OAuth surface (DCR, PKCE, audience-bound tokens) is untouched —
  GitHub authenticates the *owner*, the authorization server still issues the
  MCP tokens.
- Better Auth remains the upgrade path when we need its broader surface
  (agent identities, user management). The seam interface
  (`authenticateOwner → {email}`) is stable; swapping back is contained.
- Owner sessions live in a deny-all RLS table (`oauth_owner_sessions`,
  sha256-hashed tokens) on the same trust lane as MCP tokens.
