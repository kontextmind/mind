# Secret Gates

Status: **v1**

LLM redaction is defense-in-depth. The controls are deterministic.

## Gate 1 — pre-LLM (client-side, in the harvest skill/CLI)

Runs before session content reaches any LLM or the server:

- Pattern redaction: API keys/tokens (known formats + entropy heuristic), connection
  strings, `.env` blocks, private keys, cloud credential blobs.
- Redacted spans replaced with stable markers (`[REDACTED:token-1]`) so the LLM can
  still reason about structure.
- Harvest input stays minimal by policy: diffs + summaries, never full logs/env dumps.

## Gate 2 — pre-commit (server-side)

Runs on every KontextMind→git commit (inbox drafts, promotions, everything):

- gitleaks-class scanner over the exact content about to be committed.
- **Per-org denylists**: client names, proprietary identifiers, project codenames —
  configured as fixtures per namespace, matched case-insensitively.
- On hit: commit blocked, draft quarantined (`review_items.kind = 'suspicious'`),
  author notified with the matched rule (never the matched secret).

## False positives

Override path exists and is audited: reviewer approves with mandatory reason code;
the override is recorded on the review item and visible on the dashboard.

## Key custody

| Credential | Storage | Rotation |
|---|---|---|
| GitHub App private key | K8s secret (deploy) / env (self-host) | quarterly runbook; revoke+reissue |
| GitHub App installation tokens | n/a (1h ephemeral by design) | automatic |
| DB credentials | K8s secret / env | quarterly runbook |
| JWT signing keys | server-managed | on rotation, old keys honored until token expiry |

## Test fixtures

`tests/fixtures/secrets/` contains synthetic secrets (fake formats) and denylist
cases; both gates run against them in CI. A gate that misses a fixture fails the build.
