# AGENTS.md — KontextMind

Instructions for AI coding agents working in this repo.

## What this is

KontextMind is a memory + work-context + workflow-intelligence layer for AI coding
agents: one Bun/TS server + one Postgres, git-canonical mind repos, MCP delivery.
Read `README.md`, then the contracts in `docs/` before non-trivial changes.

## Non-negotiables

1. **The evidence spine is sacred.** The `KM-Session` commit-trailer contract
   (`docs/session-spine.md`) and `km_*` tool schemas (`docs/protocol.md`) are
   versioned protocol surface. Breaking changes require a version bump + migration
   note, never silent drift.
2. **Isolation harness gates every merge.** Branch protection on `main`
   requires the CI `test` check (full suite + `tests/isolation/` deny harness)
   with an up-to-date branch, enforced for admins too — no bypass. Any change
   touching RLS, claims, or query paths needs a deny-test.
3. **Secret gates are deterministic.** Never rely on LLM redaction alone; the
   server-side scan gate (`docs/secret-gates.md`) blocks commits.
4. **No vanity metrics.** Every dashboard panel answers "what decision does this
   change?" Speed metrics always ship with their quality complement.
5. **Self-report gets half weight, max.** Anything an agent claims about itself is
   a hint; git/CI evidence is the metric.

## Conventions

- TypeScript strict; Bun runtime; no framework without a decision record.
- Migrations are numbered, idempotent, replayable (`migrations/NNNN_*.sql`).
- Every indexed artifact carries `repo_id` + `commit_sha` (consistency contract).
- Tests colocated in `tests/`; isolation harness in `tests/isolation/`.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).

## Commands

```bash
bun install              # Windows note: bun 1.3.10 lockfile-replace bug on some
                         # machines — use `bun install --no-save` if EINVAL appears
bun run dev              # server on :3000 (/healthz)
bun test                 # all tests
bun run test:isolation   # two-tenant deny harness
bun run db:migrate       # apply migrations to $DATABASE_URL
```
