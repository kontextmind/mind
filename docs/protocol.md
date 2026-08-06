# KontextMind Protocol (km_*)

Status: **v0.1 (pre-freeze — shapes stabilize during phase 1a, then freeze as v1)**

The MCP tool surface. This document is the protocol spec: other tools may implement
or consume these shapes without running the KontextMind server.

Transport: MCP Streamable HTTP. Auth: OAuth 2.1 per the MCP authorization spec
(protected-resource metadata, DCR, PKCE, RFC 8707 audience binding).

## Tools

### Knowledge

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `km_search` | `query`, `namespace?`, `limit?`, `status?` | hits: `{path, excerpt, score, status, author, commit_sha, indexed_at}` | hybrid FTS (+pgvector later); staleness per hit |
| `km_read` | `path`, `namespace?`, `ref?` | page content + frontmatter + provenance | |
| `km_list` | `namespace?`, `prefix?` | page tree | |
| `km_graph` | `path`, `depth?` (1–2) | wikilink neighborhood | traversal only, no analytics |
| `km_append` | `namespace`, `path?`, `content`, `classification` | draft ref | two secret gates; direct inbox commit; read-your-writes |
| `km_review` | `action: list\|resolve`, `id?`, `verdict?`, `reason?` | review items | constrained actions: promote\|research\|skip\|suspicious |
| `km_status` | — | indexed SHA, lag, trust mode, current process block, beacon handshake | first call of a session carries skill context (beacon) |

### Work context

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `km_work_current` | `namespace?` | tracker read-through (Linear/GitHub, cached) + open handoffs + latest checkpoints | |
| `km_work_update` | `task_ref`, `note`, `status?` | checkpoint ref | TTL ~90d, size-capped, secret-scanned |
| `km_handoff_save` | `task_ref`, `state`, `next_steps[]` | handoff id | bounded state JSON, idempotency key |
| `km_handoff_load` | `id`, `claim?` | handoff + claim lease | lease expiry releases stale claims |

### Intelligence

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `km_insights` | `namespace?`, `kind?` | ≤3 task-scoped insights | pull-only; verdicts required on dismiss |

## Conventions

- Every response that serves knowledge includes `commit_sha` + `indexed_at`.
- Errors: MCP error codes; auth failures HTTP 401 with `WWW-Authenticate` per RFC 9728.
- Rate limits per identity; budgets per trust mode.
- Versioning: additive changes only within a major; breaking → new major + migration.
