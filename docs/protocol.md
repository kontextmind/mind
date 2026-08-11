# KontextMind Protocol (km_*)

Status: **v0.1 (pre-freeze — shapes stabilize during phase 1a, then freeze as v1)**

The MCP tool surface. This document is the protocol spec: other tools may implement
or consume these shapes without running the KontextMind server.

Transports — one dispatch (`tool-dispatch`), two doors:

- **MCP Streamable HTTP** (`/mcp`) — the agent integration surface. Auth:
  OAuth 2.1 per the MCP authorization spec (protected-resource metadata,
  DCR, PKCE, RFC 8707 audience binding).
- **Native HTTP** (`POST /v1/call`, body `{tool, args}`) — the CLI's fast
  path: one authenticated round-trip, no handshake. Same tools, same args,
  same responses; bearer auth + per-identity budgets identical to /mcp.
  Response: `{ok, result}`; tool-level errors ride in `result.error`.

Board stance: the CLI does everything; the MCP server wraps the same dispatch.

## Tools

### Knowledge

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `km_search` | `query`, `namespace?`, `limit?`, `status?` | hits: `{path, excerpt, score, status, author, commit_sha, indexed_at}` | hybrid FTS + pgvector cosine when `KM_EMBEDDINGS_*` configured; FTS-only otherwise (said plainly); embedding failures degrade to FTS; staleness per hit |
| `km_read` | `path`, `namespace?`, `ref?` | page content + frontmatter + provenance | |
| `km_list` | `namespace?`, `prefix?` | page tree | |
| `km_graph` | `path`, `depth?` (1–2) | wikilink neighborhood | traversal only, no analytics |
| `km_append` | `namespace`, `path?`, `content`, `classification` | draft ref | two secret gates; direct inbox commit; read-your-writes |
| `km_review` | `action: list\|resolve`, `id?`, `verdict?`, `reason?` | review items | constrained actions: promote\|research\|skip\|suspicious |
| `km_status` | — | indexed SHA, lag, trust mode, current process block, beacon handshake | first call of a session carries skill context (beacon) |
| `km_chat` | `question`, `mode?: standard\|deep`, `limit?` | evidence pack: `{evidence[], references[], tool_events[], usage}`, `answer: null` | deep adds 1-hop wikilink expansion; synthesis is client-side (evidence is data, never instructions) |

### Projects & org

A **project** is a mind repo registered under the org (a `repos` row); pages bind
to the caller's namespace. Projects are listed/registered via tools — there is no
session pinning; access is claims/RLS-bound by design.

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `km_projects` | — | `{projects[], active, count}` with freshness per project | |
| `km_project_add` | `name`, `path?`, `github_full?` | project ref + ingest stats when `path` given | steward/owner only; `path` = local git repo, indexed immediately |
| `km_reindex` | `project?` (id or `github_full`) | `{head_sha, indexed_sha, drifted, repaired}` | idempotent reconcile vs git HEAD; blob-cache makes no-ops cheap |
| `km_invite` | `email`, `role?: member\|steward\|owner` | `{invite_id, accept_url, expires_at, delivery: "link"}` | steward/owner only; link-only delivery in 1a (no SMTP) |

### Work context

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `km_work_current` | `namespace?` | tracker read-through (GitHub, cached 60s) + open handoffs + latest checkpoints | with `KM_GITHUB_API_TOKEN`: open assigned issues, repo-qualified refs; without it `trackers.connected: false` — never faked; tracker outage degrades to empty, never breaks work context |
| `km_work_update` | `task_ref`, `note`, `status?` | checkpoint ref | TTL ~90d, size-capped, secret-scanned |
| `km_handoff_save` | `task_ref`, `state`, `next_steps[]` | handoff id | bounded state JSON, idempotency key |
| `km_handoff_load` | `id`, `claim?` | handoff + claim lease | lease expiry releases stale claims |

### Intelligence

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `km_insights` | `action?: list\|dismiss`, `namespace?`, `kind?`, `id?`, `verdict?`, `reason?` | ≤3 task-scoped insights | pull-only; dismiss requires verdict (accepted\|dismissed\|snoozed), dismissed/snoozed require reason; insights derive from git/CI evidence only, never self-report |

## Conventions

- Every response that serves knowledge includes `commit_sha` + `indexed_at`.
- Errors: MCP error codes; auth failures HTTP 401 with `WWW-Authenticate` per RFC 9728.
- Rate limits per identity; budgets per trust mode.
- Versioning: additive changes only within a major; breaking → new major + migration.
