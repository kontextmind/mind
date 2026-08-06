# KontextMind

**The persistent mind behind every AI agent.** · [kontextmind.com](https://kontextmind.com)

A self-hostable, git-canonical **memory + work-context + workflow-intelligence** layer
for AI coding agents. Any developer, any project, any agent connects with one command
and an OAuth login.

- **Knowledge plane** — markdown "mind repos" (OKF/Karpathy wiki format), PR-review-gated
  promotion, commit-SHA provenance, hybrid search over MCP.
- **Work context** — session checkpoints and claimable handoffs; tasks/milestones read
  through to your existing trackers (Linear/GitHub).
- **Workflow Intelligence** — observes agent work through a git/CI evidence spine
  (`KM-Session` commit trailers), detects loop patterns, drift, and knowledge gaps,
  and recommends improvements with proof on a dashboard.

> Status: **phase 0** (foundation). See `docs/` for the contracts and the plan of record.

## Quickstart (demo)

```bash
bun install --no-save        # root (Windows bun lockfile bug: --no-save)
cd server && bun install --no-save && cd ..
bun run seed                 # synthesizes demo/mind with dated git history
docker compose -f deploy/docker-compose.yml up
```

Then in another terminal:

```bash
cd cli && bun install --no-save
bun run src/index.ts search "why did KontextMind drop Supabase"
# → decisions/0007 (verified) + decisions/0006 flagged SUPERSEDED
bun run src/index.ts status
```

Or wire any MCP client to `http://localhost:3000/mcp` with bearer token
`km-demo-local`. The wow beat: ask about the Supabase decision and watch the
mind flag its own stale page with the superseding decision.

## One unit, no lock-in

KontextMind is one self-contained deployable: a Bun/TS server + one Postgres
(pgvector, FTS, RLS). Auth lives in-process (Better Auth: GitHub OAuth, OAuth 2.1
provider for MCP with dynamic client registration, agent identities). Run it on any
Postgres 15+ — hosted or in your own VPC. Hard tenant isolation = run another instance.

```bash
docker compose up   # server + pgvector Postgres, seeded demo mind (phase 1a)
npx kontext init    # connect a project: wizard wires MCP config + skills + AGENTS.md
```

## Repository layout

| Path | What |
|---|---|
| `server/` | KontextMind server (MCP endpoint, indexer, review queue, WI analytics) |
| `cli/` | `kontext` CLI (init wizard, login, status, agent identities) |
| `skills/` | Agent Skills (open standard, docs-only): query / harvest / triage / status |
| `migrations/` | Postgres schema + RLS policies |
| `deploy/` | docker-compose dev stack; k8s manifests later |
| `docs/` | Contracts: threat model, authz matrix, consistency, evidence trailers, trust modes, secret gates |
| `tests/isolation/` | Two-tenant deny harness — CI merge blocker |

## Core contracts (read these first)

- [Consistency contract](docs/consistency-contract.md) — git is canonical by commit SHA, not by policy.
- [Agent Evidence Trailers v1](docs/session-spine.md) — the `KM-Session` commit-trailer spec.
- [Trust modes](docs/trust-modes.md) — `relaxed | standard | strict` per instance/namespace.
- [Threat model](docs/threat-model.md) · [Authz matrix](docs/authz-matrix.md) · [Secret gates](docs/secret-gates.md)

## Principles

1. **Evidence over self-report.** Workflow metrics join to git/CI truth; agents can omit but not fake.
2. **Git-canonical knowledge.** Diffable, reviewable, portable. The index is disposable.
3. **No PR barrage.** Drafts commit directly; promotion is a review-queue click.
4. **Departure as trustworthy as arrival.** One command exports everything to human-readable git files.
5. **Every dashboard panel answers "what decision does this change?"** No vanity metrics.

## License

Apache-2.0 — see [LICENSE](LICENSE). (Board note: license choice is final for public
release once the first outside commit lands; revisit before then if positioning changes.)
