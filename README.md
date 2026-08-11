# KontextMind

**The persistent mind behind every AI agent.** · [kontextmind.com](https://kontextmind.com)

A self-hostable, git-canonical **memory + work-context + workflow-intelligence** layer
for AI coding agents. Any developer, any project, any agent connects with one command
and an OAuth login.

- **Knowledge plane** — markdown "mind repos" (OKF/Karpathy wiki format), PR-review-gated
  promotion, commit-SHA provenance, hybrid FTS+vector search over MCP.
- **Work context** — session checkpoints and claimable handoffs; tasks read through
  to your existing trackers (GitHub today, Linear next).
- **Workflow Intelligence** — observes agent work through a git/CI evidence spine
  (`KM-Session` commit trailers joined server-side from webhooks), detects loop
  patterns and knowledge gaps, and recommends improvements with proof.

> Status: **v0.1.0, public** — see [releases](https://github.com/kontextmind/mind/releases)
> and the contracts in `docs/`.

## Quickstart

**Zero install** (Node ≥ 18.17, one persistent data directory):

```bash
npx kontextmind serve        # boots on http://127.0.0.1:13013/mcp
                             # data: ~/.kontextmind (mind git repo + server.json)
                             # db: DATABASE_URL → docker container → local Postgres
```

**From source:**

```bash
git clone https://github.com/kontextmind/mind.git && cd mind
bun install --no-save            # Windows bun lockfile bug: --no-save
cd server && bun install --no-save && cd ..
bun run seed                     # synthesizes demo/mind with dated git history
docker compose -f deploy/docker-compose.yml up
```

Then in another terminal:

```bash
npm install -g @kontextmind/cli
kontext search "why did KontextMind drop Supabase"
# → decisions/0007 (verified) + decisions/0006 flagged SUPERSEDED
```

Or wire any MCP client to `http://localhost:3000/mcp` with bearer token
`km-demo-local`. The wow beat: ask about the Supabase decision and watch the
mind flag its own stale page with the superseding decision.

## Connect a project

```bash
kontext login   # hosted mode: OAuth via device code (approve in your browser)
kontext init    # MCP config + commit-msg trailer hook + AGENTS.md contract
kontext doctor  # verify the installation + check for new releases
```

`init` is idempotent — re-running it is the upgrade path when a new release
lands. The commit-msg hook attaches the `KM-Session` evidence trailer to every
commit made in an active session; agents can omit trailers but never fake them.

## One unit, no lock-in

KontextMind is one self-contained deployable: a Bun/TS server + one Postgres
(pgvector, FTS, RLS). Hosted-mode auth lives in-process — OAuth 2.1 for MCP
(PKCE, dynamic client registration, RFC 8707 audience binding, consent,
device grant for headless boxes) with GitHub as the owner identity. Run it on
any Postgres 15+ — hosted or in your own VPC. Hard tenant isolation = run
another instance.

## Repository layout

| Path | What |
|---|---|
| `server/` | KontextMind server (MCP endpoint, indexer, OAuth AS, webhook join, WI detectors) |
| `cli/` | `kontext` CLI — published as [`@kontextmind/cli`](https://www.npmjs.com/package/@kontextmind/cli) |
| `serve/` | `kontextmind` server package — `npx kontextmind serve`, zero-install with one persistent data dir |
| `skills/` | Agent Skills (open standard, docs-only): query / harvest / triage / status |
| `migrations/` | Postgres schema + RLS policies (numbered, idempotent) |
| `deploy/` | docker-compose dev stack; Dockerfile for hosted |
| `docs/` | Contracts: threat model, authz matrix, consistency, evidence trailers, trust modes, secret gates, hosted auth, webhooks |
| `docs/decisions/` | Decision records (e.g. 0001 — native GitHub OAuth, Better Auth deferred) |
| `tests/isolation/` | Two-tenant deny harness — CI merge blocker |

## Core contracts (read these first)

- [Consistency contract](docs/consistency-contract.md) — git is canonical by commit SHA, not by policy.
- [Agent Evidence Trailers v1](docs/session-spine.md) — the `KM-Session` commit-trailer spec.
- [GitHub webhook ingestion](docs/webhooks.md) — how trailers join to `git_evidence` (webhooks only, never self-report).
- [Hosted auth](docs/hosted-auth.md) — OAuth 2.1 surface, owner seam, consent, device grant.
- [Threat model](docs/threat-model.md) · [Authz matrix](docs/authz-matrix.md) · [Secret gates](docs/secret-gates.md)

## Principles

1. **Evidence over self-report.** Workflow metrics join to git/CI truth; agents can omit but not fake.
2. **Git-canonical knowledge.** Diffable, reviewable, portable. The index is disposable.
3. **No PR barrage.** Drafts commit directly; promotion is a review-queue click.
4. **Departure as trustworthy as arrival.** One command exports everything to human-readable git files.
5. **Every dashboard panel answers "what decision does this change?"** No vanity metrics.

## License

Apache-2.0 — see [LICENSE](LICENSE).
