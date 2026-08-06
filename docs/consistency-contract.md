# Consistency Contract

Status: **v1 (frozen — changes require version bump)**

Git is canonical **by immutable commit SHA, not by policy**. The Postgres index is a
disposable projection: it must always be rebuildable from the mind repo without loss.

## Invariants

1. **Provenance.** Every indexed page, chunk, graph edge, review item, and doc claim
   carries `repo_id` + `commit_sha` identifying the exact git state it was built from.
2. **Idempotent, monotonic, replayable indexing.** Re-processing the same commit is a
   no-op. Older commits never overwrite newer index state (compare before write).
   Full re-index from git history is a supported operation at all times.
3. **Reconciliation.** A reconcile job diffs `git tree SHA` vs `ingest_cache` per repo:
   - triggered by webhook, and at least nightly;
   - repairs missing/stale entries; tombstones deletions and renames;
   - emits `index_lag_seconds` and `reconcile_repairs_total` metrics.
4. **Visible staleness.** `km_search` and `km_status` responses include the indexed
   `commit_sha` and `indexed_at` so clients can see how fresh the answer is.
5. **Read-your-writes.** After `km_append` succeeds, the appending principal can
   immediately retrieve the draft (drafts are indexed on write, not on webhook).
6. **Deletions and renames.** Deleted pages leave tombstones (searchable as "removed",
   never served as content). Renames update edges and back-references atomically.
7. **Webhooks are untrusted input.** Webhooks may drop, duplicate, or reorder. The
   webhook handler is a cache-warmer; the reconcile job is the source of truth.
   Dead-letter + alerting for repeated webhook failure.

## Failure semantics

| Failure | Behavior |
|---|---|
| Webhook dropped | Nightly reconcile repairs; lag metric rises; alert at SLO breach |
| Index write fails | Retry with backoff; entry stays stale until reconcile; never partial row |
| Embedding model change | New `embedder_version` column value; background re-embed; old vectors served until done |
| Mind repo force-push | Reconcile detects SHA divergence; full re-index of affected repo; incident logged |

## SLO (pilot targets)

- Index lag p95 < 60 s after merge; reconcile catches 100% of drift within 24 h.
- `km_search` availability = server availability; stale answers are acceptable only
  when labeled stale.
