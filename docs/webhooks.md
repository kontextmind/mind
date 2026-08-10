# GitHub Webhook Ingestion

Status: **v1** · the server-side join of [Agent Evidence Trailers](session-spine.md)

`git_evidence` is populated **only** from this webhook path — never from agent
self-report. This is what makes the evidence spine trustworthy: agents can omit
trailers but cannot fake attribution.

## Endpoint

```
POST /webhooks/github
X-GitHub-Event: push | check_suite | pull_request | ping
X-Hub-Signature-256: sha256=<hex>
```

- Signature: HMAC-SHA256 over the raw request body with `KM_GITHUB_WEBHOOK_SECRET`.
  Constant-time compare; missing/invalid signatures → `401`.
- **Fail-closed**: when `KM_GITHUB_WEBHOOK_SECRET` is unset the endpoint returns
  `503 webhook_secret_not_configured`. There is never an open ingestion path.
- Body cap 5 MB → `413`. Unparseable JSON → `400`. Non-POST → `405`.
- Unregistered repos, unsupported events, and not-yet-completed check suites are
  acknowledged with `200 {ignored: ...}` so GitHub does not retry stable failures.

## Events

### `push`
For each commit in `payload.commits`:

1. Parse `KM-Session` trailers (`parseKmTrailers`, deduped).
2. Each trailer resolves only when the session **exists** and **the session's org
   owns the repo** (tenant boundary, checked at join time).
3. Resolved → `git_evidence(session_id, repo_id, sha)`, idempotent on redelivery.
   Multiple trailers on one commit → one row per session (the spine allows
   multi-session commits).
4. Unresolved (unknown ID or cross-org claim) → `km_unresolved_trailers`. Never
   silently dropped; feeds the coverage metric.
5. No trailer → allowed (omission), attributes nothing.

### `check_suite`
On `status=completed`, sets `ci_status = conclusion` for rows at `head_sha`;
`first_green_at` is stamped once on the first `success`.

### `pull_request`
- `opened`/`synchronize`: attaches `pr_number` to evidence rows at
  `pull_request.head.sha` (the push events for the branch created them).
- `closed` with `merged=true`: stamps `merged_at` on the merge-commit row.

### Coverage metric
`resolved / (resolved + unresolved)` of observed trailers, per repo/agent —
low coverage means an instrumentation gap (emitters not shipping trailers),
which is exactly what the dashboard should surface. Unattributable commits
(no trailer) are not evidence for or against anyone.

## Isolation

Writes run on the superuser ingestion lane (same as the indexer) because the
webhook caller has no user claims. `git_evidence` and `km_unresolved_trailers`
carry no permissive write policies for `km_app`, and their RLS read policies
are org-scoped through the repo's org — asserted by deny-tests in
`tests/isolation/`.
