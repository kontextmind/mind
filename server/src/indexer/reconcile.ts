/**
 * Reconcile: repair index drift against git HEAD.
 * Webhooks (hosted mode) are cache-warmers; this job is the source of truth
 * (docs/consistency-contract.md). In 1a it runs at boot and on demand via
 * km_status; a scheduled interval lands in 1c.
 */
import type postgres from "postgres";
import * as gitMod from "./git";
import { ingestRepo } from "./ingest";
import type { EmbedFn } from "../embeddings";

export interface ReconcileResult {
  repoId: string;
  headSha: string;
  indexedSha: string | null;
  drifted: boolean;
  repaired: boolean;
}

export async function reconcileRepo(
  sql: postgres.Sql,
  opts: {
    repoId: string;
    namespaceId: string;
    repoPath: string;
    repair?: boolean;
    /** Forwarded to ingestRepo when drift repair re-ingests. */
    embed?: EmbedFn | null;
    embedderVersion?: string;
  },
): Promise<ReconcileResult> {
  const repair = opts.repair ?? true;
  const head = gitMod.headSha(opts.repoPath);
  const rows = await sql`select head_sha from repos where id = ${opts.repoId}`;
  const indexedSha = (rows[0]?.head_sha as string | null) ?? null;
  const drifted = indexedSha !== head;

  let repaired = false;
  if (drifted && repair) {
    await ingestRepo(sql, opts);
    repaired = true;
  }

  return { repoId: opts.repoId, headSha: head, indexedSha, drifted, repaired };
}
