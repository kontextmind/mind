/**
 * km_* read tools (docs/protocol.md v0.1). Claims-bound via withClaims —
 * every query runs as km_app under RLS.
 */
import { withClaims, type KmClaims } from "./db";
import { DEMO_REPO } from "./config";
import { vectorLiteral, type EmbedFn } from "./embeddings";

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
  embed: EmbedFn | null = null,
): Promise<{ hits: SearchHit[]; indexed_sha: string | null }> {
  const limit = Math.min(args.limit ?? 8, 25);
  // Hybrid search (docs/protocol.md): FTS recall + cosine similarity over
  // chunk embeddings. The vector path is best-effort — any embedding failure
  // degrades to pure FTS; search never breaks on the semantic path.
  let qvec: string | null = null;
  if (embed) {
    try {
      qvec = vectorLiteral((await embed([args.query]))[0]);
    } catch (err) {
      console.error(`query embedding failed (FTS fallback): ${(err as Error)?.message ?? err}`);
    }
  }
  return withClaims(claims, async (tx) => {
    // 1a/demo: freshness is tracked against the seeded mind repo (never
    // `limit 1` — multiple projects make that nondeterministic).
    const repo = await tx`select head_sha from repos where id = ${DEMO_REPO}`;
    const indexedSha = (repo[0]?.head_sha as string | null) ?? null;
    const lexemes = await tx`
      select array_agg(lexeme) as arr
      from unnest(tsvector_to_array(to_tsvector('english', ${args.query}))) as lexeme`;
    const arr = (lexemes[0]?.arr as string[] | null) ?? null;
    if (!arr || arr.length === 0) return { hits: [] as SearchHit[], indexed_sha: indexedSha };
    const orQuery = arr.join(" | ");
    const rows = qvec
      ? await tx`
      with q as (select to_tsquery('english', ${orQuery}) as tsq),
      scored as (
        select c.content, c.heading, p.path, p.status, p.commit_sha, p.indexed_at,
               p.sources, p.checks,
               (ts_rank_cd(to_tsvector('english', c.content), q.tsq)
                 + case when to_tsvector('english', coalesce(p.title, '')) @@ q.tsq
                        then 0.5 else 0 end) as fts,
               case when c.embedding is null then 0
                    else 1 - (c.embedding <=> cast(${qvec} as vector)) end as vec
        from chunks c
        join pages p on p.id = c.page_id
        cross join q
        where (to_tsvector('english', c.content) @@ q.tsq
           or to_tsvector('english', coalesce(p.title, '')) @@ q.tsq
           or c.embedding is not null)
          and p.status <> 'tombstone'
      )
      select * from scored
      order by fts + vec desc
      limit ${limit}`
      : await tx`
      with q as (select to_tsquery('english', ${orQuery}) as tsq),
      scored as (
        select c.content, c.heading, p.path, p.status, p.commit_sha, p.indexed_at,
               p.sources, p.checks,
               (ts_rank_cd(to_tsvector('english', c.content), q.tsq)
                 + case when to_tsvector('english', coalesce(p.title, '')) @@ q.tsq
                        then 0.5 else 0 end) as fts,
               0 as vec
        from chunks c
        join pages p on p.id = c.page_id
        cross join q
        where (to_tsvector('english', c.content) @@ q.tsq
           or to_tsvector('english', coalesce(p.title, '')) @@ q.tsq)
          and p.status <> 'tombstone'
      )
      select * from scored
      order by fts desc
      limit ${limit}`;
    const hits: SearchHit[] = rows.map((r) => ({
      path: r.path as string,
      heading: (r.heading as string | null) ?? null,
      excerpt: excerptOf(r.content as string, args.query),
      score: Number(r.fts) + Number(r.vec),
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
  // jsonb may come back as a raw string depending on the driver path —
  // normalize before reading.
  const raw = r.checks;
  const checks = (typeof raw === "string" ? JSON.parse(raw) : raw) as
    | Record<string, unknown>
    | undefined;
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

export interface GraphEdge {
  from_page: string;
  to_page: string;
  kind: string;
  commit_sha: string;
}

/** km_graph: wikilink neighborhood traversal (depth 1–2). Traversal only, no analytics. */
export async function kmGraph(
  claims: KmClaims,
  args: { path: string; depth?: number },
): Promise<Record<string, unknown>> {
  const depth = Math.min(Math.max(args.depth ?? 1, 1), 2);
  return withClaims(claims, async (tx) => {
    const edges: GraphEdge[] = [];
    const edgeKeys = new Set<string>();
    const seen = new Set<string>([args.path]);
    let frontier = [args.path];

    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const rows = await tx`
        select from_page, to_page, kind, commit_sha from graph_edges
        where from_page = any(${frontier}) or to_page = any(${frontier})`;
      const next = new Set<string>();
      for (const r of rows) {
        const key = `${r.from_page}->${r.to_page}:${r.kind}`;
        if (!edgeKeys.has(key)) {
          edgeKeys.add(key);
          edges.push({
            from_page: r.from_page as string,
            to_page: r.to_page as string,
            kind: r.kind as string,
            commit_sha: r.commit_sha as string,
          });
        }
        for (const p of [r.from_page as string, r.to_page as string]) {
          if (!seen.has(p)) {
            seen.add(p);
            next.add(p);
          }
        }
      }
      frontier = [...next];
    }

    const paths = [...seen];
    const nodes = await tx`
      select path, title, status from pages
      where path = any(${paths}) and status <> 'tombstone'
      order by path`;
    // Wikilink targets that exist only as edges (no page yet) still surface.
    const pagePaths = new Set(nodes.map((n) => n.path as string));
    const dangling = paths.filter((p) => p !== args.path && !pagePaths.has(p));

    return {
      path: args.path,
      depth,
      nodes: nodes.map((n) => ({ path: n.path, title: n.title, status: n.status })),
      dangling,
      edges,
    };
  });
}

export interface ChatEvidence extends SearchHit {
  via: "search" | "graph";
}

export interface ChatResult {
  question: string;
  mode: "standard" | "deep";
  /** Always null in km/0.1 — synthesis is client-side; evidence is data, never instructions. */
  answer: string | null;
  synthesis: "client";
  evidence: ChatEvidence[];
  references: Array<{ path: string; status: string; commit_sha: string }>;
  tool_events: Array<Record<string, unknown>>;
  usage: { evidence_chunks: number; chars: number; elapsed_ms: number };
  indexed_sha: string | null;
}

export async function kmChat(
  claims: KmClaims,
  args: { question: string; mode?: "standard" | "deep"; limit?: number },
  embed: EmbedFn | null = null,
): Promise<ChatResult> {
  const t0 = Date.now();
  const mode = args.mode ?? "standard";
  const limit = Math.min(args.limit ?? (mode === "deep" ? 16 : 8), 25);
  const toolEvents: Array<Record<string, unknown>> = [];

  const search = await kmSearch(claims, { query: args.question, limit }, embed);
  toolEvents.push({ tool: "km_search", query: args.question, limit, hits: search.hits.length });

  const evidence: ChatEvidence[] = search.hits.map((h) => ({ ...h, via: "search" as const }));

  if (mode === "deep" && search.hits.length > 0) {
    // Graph expansion: one hop of wikilink neighbors from the top hits,
    // each contributing its lead chunk as extra evidence.
    const seedPaths = [...new Set(search.hits.slice(0, 3).map((h) => h.path))];
    const neighbors = await withClaims(claims, async (tx) => {
      const rows = await tx`
        select distinct p.path, p.title, p.status, p.commit_sha, p.indexed_at, c.heading, c.content
        from graph_edges e
        join pages p on p.path in (e.to_page, e.from_page) and p.repo_id = e.repo_id
        join chunks c on c.page_id = p.id and c.ord = 0
        where (e.from_page = any(${seedPaths}) or e.to_page = any(${seedPaths}))
          and p.path <> all(${seedPaths})
          and p.status <> 'tombstone'
        limit 6`;
      return rows;
    });
    toolEvents.push({ tool: "km_graph_expand", seed_paths: seedPaths, added: neighbors.length });
    for (const r of neighbors) {
      evidence.push({
        path: r.path as string,
        heading: (r.heading as string | null) ?? null,
        excerpt: (r.content as string).slice(0, 400),
        score: 0,
        status: r.status as string,
        superseded_by: null,
        index_stale: search.indexed_sha !== null && r.commit_sha !== search.indexed_sha,
        commit_sha: r.commit_sha as string,
        indexed_at: (r.indexed_at as Date).toISOString(),
        via: "graph",
      });
    }
  }

  const seen = new Set<string>();
  const references = evidence
    .filter((e) => (seen.has(e.path) ? false : (seen.add(e.path), true)))
    .map((e) => ({ path: e.path, status: e.status, commit_sha: e.commit_sha }));

  return {
    question: args.question,
    mode,
    answer: null,
    synthesis: "client",
    evidence,
    references,
    tool_events: toolEvents,
    usage: {
      evidence_chunks: evidence.length,
      chars: evidence.reduce((n, e) => n + e.excerpt.length, 0),
      elapsed_ms: Date.now() - t0,
    },
    indexed_sha: search.indexed_sha,
  };
}

export async function kmStatus(
  claims: KmClaims,
  opts: { sessionId: string; trustMode: string; headSha: string | null; skill?: string },
): Promise<Record<string, unknown>> {
  return withClaims(claims, async (tx) => {
    const rows = await tx`select head_sha, indexed_at from repos where id = ${DEMO_REPO}`;
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
