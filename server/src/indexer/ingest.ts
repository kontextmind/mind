/**
 * SHA-first ingestion (docs/consistency-contract.md):
 *  - never index without recording the commit SHA
 *  - blob-SHA cache: unchanged content is skipped
 *  - idempotent + replayable
 *
 * Runs on the ADMIN connection (indexer role); serving queries happens on
 * the claims-bound request connection.
 */
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { chunkPage, wikilinks } from "./parse";
import * as gitMod from "./git";

export interface IngestStats {
  pages: number;
  chunks: number;
  skipped: number;
  headSha: string;
}

export async function ingestRepo(
  sql: postgres.Sql,
  opts: { repoId: string; namespaceId: string; repoPath: string },
): Promise<IngestStats> {
  const { repoId, namespaceId, repoPath } = opts;
  const head = gitMod.headSha(repoPath);
  const entries = gitMod.tree(repoPath);
  const stats: IngestStats = { pages: 0, chunks: 0, skipped: 0, headSha: head };

  const cached = new Map<string, string>(
    (
      await sql`select path, sha256 from ingest_cache where repo_id = ${repoId}`
    ).map((r) => [r.path as string, r.sha256 as string]),
  );

  const seen = new Set<string>();

  for (const entry of entries) {
    seen.add(entry.path);
    const content = gitMod.readBlob(repoPath, entry.blobSha);
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (cached.get(entry.path) === sha256) {
      stats.skipped++;
      continue;
    }

    const { meta, chunks } = chunkPage(content);
    const pageId = `page_${createHash("sha1").update(`${repoId}:${entry.path}`).digest("hex").slice(0, 26)}`;
    const checks = meta.supersededBy ? { superseded_by: meta.supersededBy } : {};

    await sql.begin(async (tx) => {
      await tx`insert into pages (id, repo_id, namespace_id, path, title, status, commit_sha, sources, checks, indexed_at)
        values (${pageId}, ${repoId}, ${namespaceId}, ${entry.path},
                ${meta.title ?? entry.path}, ${pageStatus(meta)}, ${head}, '[]', ${checks}, now())
        on conflict (repo_id, path) do update set
          title = excluded.title, status = excluded.status, commit_sha = excluded.commit_sha,
          checks = excluded.checks, indexed_at = now()`;
      await tx`delete from chunks where page_id = ${pageId}`;
      for (const c of chunks) {
        await tx`insert into chunks (id, page_id, namespace_id, ord, content, heading, commit_sha)
          values (${`${pageId}_${c.ord}`}, ${pageId}, ${namespaceId}, ${c.ord}, ${c.content}, ${c.heading}, ${head})`;
      }
      await tx`delete from graph_edges where repo_id = ${repoId} and from_page = ${entry.path}`;
      for (const target of wikilinks(content)) {
        const edgeId = `edge_${createHash("sha1")
          .update(`${repoId}:${entry.path}->${target}`)
          .digest("hex")
          .slice(0, 22)}`;
        await tx`insert into graph_edges (id, repo_id, namespace_id, from_page, to_page, kind, commit_sha)
          values (${edgeId}, ${repoId}, ${namespaceId}, ${entry.path}, ${target}, 'wikilink', ${head})
          on conflict (repo_id, from_page, to_page, kind) do nothing`;
      }
      await tx`insert into ingest_cache (repo_id, path, sha256, commit_sha)
        values (${repoId}, ${entry.path}, ${sha256}, ${head})
        on conflict (repo_id, path) do update set sha256 = excluded.sha256, commit_sha = excluded.commit_sha`;
    });

    stats.pages++;
    stats.chunks += chunks.length;
  }

  // Tombstone pages deleted from the tree.
  for (const path of cached.keys()) {
    if (seen.has(path)) continue;
    await sql`update pages set status = 'tombstone', commit_sha = ${head}, indexed_at = now()
      where repo_id = ${repoId} and path = ${path} and status <> 'tombstone'`;
    await sql`delete from ingest_cache where repo_id = ${repoId} and path = ${path}`;
  }

  await sql`update repos set head_sha = ${head}, indexed_at = now() where id = ${repoId}`;
  return stats;
}

function pageStatus(meta: { status: string | null; supersededBy: string | null }): string {
  if (meta.supersededBy) return "suspect";
  if (meta.status === "verified" || meta.status === "draft" || meta.status === "suspect") {
    return meta.status;
  }
  return "draft";
}
