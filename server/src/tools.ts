/**
 * km_* read tools (docs/protocol.md v0.1). Claims-bound via withClaims —
 * every query runs as km_app under RLS.
 */
import { withClaims, type KmClaims } from "./db";

export interface SearchHit {
  path: string;
  heading: string | null;
  excerpt: string;
  score: number;
  status: string;
  superseded_by: string | null;
  index_stale: boolean;
  commit_sha: string;
  indexed_at: string;
}

export async function kmSearch(
  claims: KmClaims,
  args: { query: string; limit?: number },
): Promise<{ hits: SearchHit[]; indexed_sha: string | null }> {
  const limit = Math.min(args.limit ?? 8, 25);
  return withClaims(claims, async (tx) => {
    const repo = await tx`select head_sha from repos limit 1`;
    const indexedSha = (repo[0]?.head_sha as string | null) ?? null;
    const rows = await tx`
      select c.content, c.heading, p.path, p.status, p.commit_sha, p.indexed_at,
             p.sources,
             coalesce(p.checks->>'superseded_by', null) as superseded_by,
             ts_rank_cd(to_tsvector('english', c.content), websearch_to_tsquery('english', ${args.query})) as score
      from chunks c
      join pages p on p.id = c.page_id
      where to_tsvector('english', c.content) @@ websearch_to_tsquery('english', ${args.query})
        and p.status <> 'tombstone'
      order by score desc
      limit ${limit}`;
    const hits: SearchHit[] = rows.map((r) => ({
      path: r.path as string,
      heading: (r.heading as string | null) ?? null,
      excerpt: excerptOf(r.content as string, args.query),
      score: Number(r.score),
      status: r.status as string,
      superseded_by: supersededBy(r),
      index_stale: indexedSha !== null && r.commit_sha !== indexedSha,
      commit_sha: r.commit_sha as string,
      indexed_at: (r.indexed_at as Date).toISOString(),
    }));
    return { hits, indexed_sha: indexedSha };
  });
}

function supersededBy(r: Record<string, unknown>): string | null {
  const checks = r.checks as Record<string, unknown> | undefined;
  return (checks?.superseded_by as string | undefined) ?? null;
}

function excerptOf(content: string, query: string): string {
  const firstTerm = query.split(/\s+/)[0]?.toLowerCase() ?? "";
  const idx = content.toLowerCase().indexOf(firstTerm);
  const at = idx < 0 ? 0 : Math.max(0, idx - 120);
  return content.slice(at, at + 400);
}

export async function kmRead(
  claims: KmClaims,
  args: { path: string },
): Promise<{ page: Record<string, unknown> | null }> {
  return withClaims(claims, async (tx) => {
    const rows = await tx`
      select p.path, p.title, p.status, p.commit_sha, p.indexed_at,
             string_agg(c.content, E'\n\n' order by c.ord) as body
      from pages p
      left join chunks c on c.page_id = p.id
      where p.path = ${args.path} and p.status <> 'tombstone'
      group by p.id
      limit 1`;
    if (!rows[0]) return { page: null };
    const r = rows[0];
    return {
      page: {
        path: r.path,
        title: r.title,
        status: r.status,
        commit_sha: r.commit_sha,
        indexed_at: (r.indexed_at as Date).toISOString(),
        body: r.body,
      },
    };
  });
}

export async function kmList(claims: KmClaims): Promise<{ pages: Array<{ path: string; status: string; title: string | null }> }> {
  return withClaims(claims, async (tx) => {
    const rows = await tx`
      select path, status, title from pages
      where status <> 'tombstone'
      order by path`;
    return { pages: rows.map((r) => ({ path: r.path as string, status: r.status as string, title: (r.title as string | null) ?? null })) };
  });
}

export async function kmStatus(
  claims: KmClaims,
  opts: { sessionId: string; trustMode: string; headSha: string | null; skill?: string },
): Promise<Record<string, unknown>> {
  return withClaims(claims, async (tx) => {
    const rows = await tx`select head_sha, indexed_at from repos limit 1`;
    const indexedSha = (rows[0]?.head_sha as string | null) ?? null;
    const indexedAt = rows[0]?.indexed_at as Date | undefined;
    return {
      service: "kontextmind",
      protocol: "km/0.1",
      session_id: opts.sessionId,
      trust_mode: opts.trustMode,
      indexed_sha: indexedSha,
      head_sha: opts.headSha,
      index_fresh: indexedSha !== null && indexedSha === opts.headSha,
      indexed_at: indexedAt ? indexedAt.toISOString() : null,
      beacon: opts.skill ? { skill: opts.skill, provenance: "beacon" } : null,
    };
  });
}
