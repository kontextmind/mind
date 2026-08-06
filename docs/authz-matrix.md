# Authorization Matrix

Status: **v1** — enforced in code + RLS; tested by `tests/isolation/`.

Access is: per **org** (instance boundary) → per **namespace** (RLS) → per **role**
within a namespace. Claims are bound into the JWT at issuance; clients never supply
namespace identifiers that are not validated against membership.

## Roles

| Role | Knowledge | Work context | Intelligence | Admin |
|---|---|---|---|---|
| member | read verified (+draft per trust mode); append drafts | read/write own checkpoints; save handoffs | pull km_insights | — |
| steward | member + promote/resolve review items, curate pages | member + resolve handoff disputes | member + tune noise budgets | — |
| owner | steward + manage namespaces/memberships | all | all | trust-mode overrides, agent identity approval |
| agent (client_credentials) | as granted per namespace (read-only or read+append) | checkpoints + handoffs in granted namespaces | pull km_insights | — |
| indexer (service) | read git, write index tables | — | — | never serves requests |

## Matrix (resource × principal)

| Resource | member | steward | owner | agent | other-namespace member | other-instance anyone |
|---|---|---|---|---|---|---|
| verified pages | R | RW | RW | R (or RW if granted) | deny | deny (structural) |
| draft pages | R* | RW | RW | R* | deny | deny |
| inbox drafts | R own | RW | RW | R own | deny | deny |
| review items | R | RW | RW | deny | deny | deny |
| checkpoints | RW own | RW | RW | RW own | deny | deny |
| handoffs | R + claim | RW | RW | R + claim | deny | deny |
| insights | R | RW | RW | R | deny | deny |
| memberships | — | R | RW | — | deny | deny |
| agent identities | — | R | RW | — | deny | deny |

\* per trust mode (strict: drafts not served).

## Claim shape (set per request, `SET LOCAL km.claims`)

```json
{
  "sub": "user_ulid",
  "kind": "human|agent|service",
  "org": "org_ulid",
  "namespaces": ["ns_ulid", "..."],
  "roles": { "ns_ulid": "member|steward|owner" }
}
```

RLS policies read `current_setting('km.claims', true)::jsonb`. The `service` kind is
rejected by RLS on all tenant tables; the indexer uses dedicated non-RLS schemas only.

## Deny tests (CI merge blocker)

Two-tenant fixture (org A: ns-a1/ns-a2, org B: ns-b1). For every km_* endpoint and
every table: principal from ns-a1 must be denied ns-a2 and ns-b1 resources across
search, read, append, review, work-context, and insights paths — asserted through the
full server path, not raw SQL.
