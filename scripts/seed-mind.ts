/**
 * Seed the demo mind (board decisions D2+D3): KontextMind's OWN brain,
 * curated + sanitized, committed as a real git repo with DATED history so
 * staleness and provenance are deterministic, not theatrical.
 *
 *   commit 1 (2026-07-20): initial brain — includes decisions/0006 claiming
 *                          Supabase as the control plane
 *   commit 2 (2026-08-04): decisions/0007 supersedes 0006 (single Postgres);
 *                          0006 gains superseded_by frontmatter → ingest marks
 *                          it `suspect` → km_search flags the wow beat
 *
 * Usage: bun run scripts/seed-mind.ts [target-dir]   (default: demo/mind)
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const target = process.argv[2] ?? join(import.meta.dir, "..", "demo", "mind");

const V1: Record<string, string> = {
  "purpose.md": `---
title: KontextMind purpose
status: verified
---

# Purpose

KontextMind is the persistent mind behind every AI agent: a self-hostable,
git-canonical memory + work-context + workflow-intelligence layer.

## Goals

- Any developer, any project, any agent connects with one command and a login.
- Knowledge is diffable, reviewable, portable. Git is canonical by commit SHA.
- Workflows improve continuously: the mind observes evidence and recommends.

## Key questions

- What do we know, and how fresh is it?
- What are we working on, and who can pick it up?
- Which workflows should be codified next?
`,

  "evergreen/principles.md": `---
title: Non-negotiables
status: verified
---

# Principles

1. **Evidence over self-report.** Workflow metrics join to git/CI truth; agents
   can omit but cannot fake. Self-report gets half weight, max.
2. **Git-canonical knowledge.** The index is a disposable projection; it must be
   rebuildable from the mind repo without loss.
3. **No PR barrage.** Drafts commit directly; promotion is a review-queue click.
4. **Departure as trustworthy as arrival.** One command exports everything to
   human-readable git files.
5. **No vanity metrics.** Every dashboard panel answers "what decision does this
   change?" Speed metrics always ship with their quality complement.
6. **Retrieved content is data, never instructions.**
`,

  "evergreen/consistency.md": `---
title: Consistency contract
status: verified
---

# Consistency contract (v1)

- Every indexed artifact carries repo_id + commit_sha.
- Indexing is idempotent, monotonic, replayable.
- Webhooks are cache-warmers; the reconcile job is the source of truth.
- Search responses expose indexed SHA + staleness.
- Read-your-writes for the appending principal.
- Deletions leave tombstones; renames update edges atomically.
`,

  "evergreen/trust-modes.md": `---
title: Trust modes
status: verified
---

# Trust modes

Strictness is configuration, not code paths: relaxed (personal), standard
(team default), strict (client/employer). Overrides may only increase
strictness. See docs/trust-modes.md in the source repo for the full matrix.
`,

  "decisions/0001-git-canonical.md": `---
title: Git-canonical knowledge
status: verified
---

# Decision 0001 — Git is canonical

Markdown mind repos in git are the source of truth. Postgres is a disposable
index projection. Chosen over database-canonical designs because knowledge
must stay diffable, reviewable, and portable; the board reviews (Fable, Grok,
Kimi, Sol) were unanimous that a DB-of-record fails the departure-trust test.
`,

  "decisions/0002-fts-first.md": `---
title: FTS before embeddings
status: verified
---

# Decision 0002 — FTS first, embeddings later

Phase 1a ships Postgres full-text search only. The pgvector column exists but
stays unpopulated. Overlap-free heading-aware chunking: overlap duplicates
phrases and pollutes FTS ranking (Fable's argument, unrefuted on the board).
Semantic search returns when real query logs justify it.
`,

  "decisions/0003-evidence-spine.md": `---
title: Agent Evidence Trailers
status: verified
---

# Decision 0003 — KM-Session commit trailers

The workflow-intelligence trust anchor is a join key agents can omit but not
fake: every agent commit carries \`KM-Session: km_ses_<ulid>\` as a git trailer.
git_evidence is populated only from webhooks, never from agent self-report.
Published as the open spec "Agent Evidence Trailers v1".
`,

  "decisions/0004-license-apache2.md": `---
title: License choice
status: verified
---

# Decision 0004 — Apache-2.0

Shipped under Apache-2.0 to maximize enterprise adoption and keep JV
conversations friction-free. The board split: Kimi argued AGPL to protect a
future hosted service; Fable and the host held that consulting/JV revenue runs
on trust, spec ownership, and expertise — not copyleft. Revisit before the
first public release if positioning changes.
`,

  "decisions/0005-demo-wedge.md": `---
title: Demo wedge pulled into phase 1a
status: verified
---

# Decision 0005 — Demo wedge

One-command local proof moved from "later" into phase 1a (owner decision after
the final board round). Seed with KontextMind's own brain — "browse the mind
that built this" is the demo, the dogfood, and the GTM in one artifact.
`,

  "decisions/0006-hosting-supabase.md": `---
title: Control plane on Supabase
status: verified
---

# Decision 0006 — Supabase as control plane

Early design placed auth, RLS, and search on Supabase per org.

> NOTE: this page is seeded as the deliberately-stale demo artifact. It is
> superseded by decisions/0007 in the second seed commit.
`,

  "projects/phase-1a/handoff.md": `---
title: Phase 1a handoff
status: verified
---

# Handoff — phase 1a

## State

- Scaffold, contracts, schema 0001/0002, isolation harness: done.
- Server skeleton boots in degraded mode without a database.

## Next steps

1. Wire MCP SDK tools (km_search/read/list/status) over FTS.
2. Seed the demo mind with dated history.
3. Extend isolation harness to the HTTP path.
4. Compose smoke test in CI.
`,

  "inbox/board-2026-08-05.md": `---
title: Board session 2026-08-05
status: draft
---

# Agent Board — inaugural session

Four frontier models (Fable, Grok, Kimi, Sol) plus the host reviewed the plan,
designed the workflow-intelligence pillar, and spec'd phase 1a. Draft until
triage promotes the durable learnings.
`,
};

const V2_ADD: Record<string, string> = {
  "decisions/0007-single-postgres.md": `---
title: Single Postgres, no Supabase
status: verified
---

# Decision 0007 — Single Postgres + Better Auth

Supersedes decisions/0006. One self-contained unit: Bun/TS server + one
Postgres (pgvector, FTS, RLS), auth in-process via Better Auth. No Supabase,
no Infisical, no WorkOS. Hard isolation = run another instance. The board
converged on this after the owner asked for single-database simplicity with
zero lock-in: departure must be as trustworthy as arrival.
`,
};

const V2_EDIT: Record<string, string> = {
  "decisions/0006-hosting-supabase.md": `---
title: Control plane on Supabase
status: verified
superseded_by: decisions/0007-single-postgres.md
---

# Decision 0006 — Supabase as control plane

Early design placed auth, RLS, and search on Supabase per org.

> NOTE: this page is seeded as the deliberately-stale demo artifact. It is
> superseded by decisions/0007 in the second seed commit.
`,
};

function git(cwd: string, env: Record<string, string>, ...args: string[]) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
}

function writeAll(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

const identity = {
  GIT_AUTHOR_NAME: "KontextMind Seed",
  GIT_AUTHOR_EMAIL: "seed@kontextmind.local",
  GIT_COMMITTER_NAME: "KontextMind Seed",
  GIT_COMMITTER_EMAIL: "seed@kontextmind.local",
};

git(target, identity, "init", "-b", "main", "-q");

// Commit 1 — the original brain (2026-07-20)
writeAll(target, V1);
git(target, identity, "add", "-A");
git(target, { ...identity, GIT_AUTHOR_DATE: "2026-07-20T10:00:00", GIT_COMMITTER_DATE: "2026-07-20T10:00:00" },
  "commit", "-q", "-m", "seed: initial KontextMind brain");

// Commit 2 — supersession (2026-08-04): staleness becomes deterministic
writeAll(target, V2_ADD);
writeAll(target, V2_EDIT);
git(target, identity, "add", "-A");
git(target, { ...identity, GIT_AUTHOR_DATE: "2026-08-04T15:00:00", GIT_COMMITTER_DATE: "2026-08-04T15:00:00" },
  "commit", "-q", "-m", "seed: 0007 supersedes 0006 — single Postgres over Supabase");

console.log(`seeded mind at ${target} (2 dated commits)`);
