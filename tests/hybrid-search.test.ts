/**
 * Hybrid search e2e (FTS + pgvector): deterministic mock embeddings server
 * proves the vector path actually changes ranking, that ingest fills
 * chunks.embedding, and that every failure mode degrades to FTS — search
 * never breaks on the semantic path.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { resolveDbUrl, createDisposableDb, type DisposableDb } from "./support/db";
import { endDbPools } from "../server/src/db";
import { ingestRepo } from "../server/src/indexer/ingest";
import { embedTexts, validateEmbeddings } from "../server/src/embeddings";
import { kmSearch } from "../server/src/tools";
import type { EmbeddingsConfig } from "../server/src/config";
import type { KmClaims } from "../server/src/db";

const url = resolveDbUrl("hybrid search");
const describeMaybe = url ? describe : describe.skip;

const ORG = "org_haaaaaaaaaaaaaaaaaaaaaaa";
const NS = "ns_h1aaaaaaaaaaaaaaaaaaaaaa";
const REPO = "repo_haaaaaaaaaaaaaaaaaaaaaa1";

// Shared lexicon: page A shares lexemes with the query (FTS-strong), page B
// shares none — only embeddings can surface it.
const CONTENT_A = "Postgres replication tuning notes for streaming setups";
const CONTENT_B = "Database failover runbook for replica promotion";
const QUERY = "postgres replication";

const DIM = 1536;
const unit = (axis: number): number[] => {
  const v = new Array<number>(DIM).fill(0);
  v[axis] = 1;
  return v;
};
// Query sits almost on B's axis: cosine(query, B) ≈ 0.98, cosine(query, A) ≈ 0.2.
const mix = (base: number[], other: number[], w: number): number[] => {
  const v = base.map((x, i) => x + other[i] * w);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
};
const VECTORS: Record<string, number[]> = {
  [CONTENT_A]: unit(1),
  [CONTENT_B]: unit(2),
  [QUERY]: mix(unit(2), unit(1), 0.2),
};

describeMaybe("hybrid search (FTS + pgvector)", () => {
  let sql: postgres.Sql;
  let app: postgres.Sql;
  let disposable: DisposableDb;
  let embedServer: ReturnType<typeof Bun.serve>;
  let embedCfg: EmbeddingsConfig;
  let mindPath: string;
  let failNext = false;

  const claims: KmClaims = {
    sub: "user_hybrid",
    kind: "human",
    org: ORG,
    namespaces: [NS],
    roles: { [NS]: "member" },
  };

  const embed = (texts: string[]) => embedTexts(embedCfg, texts);

  beforeAll(async () => {
    embedServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const body = (await req.json().catch(() => null)) as { input?: string[] } | null;
        // Body consumed BEFORE any early return; Connection: close on every
        // response — reused keep-alive sockets stalled follow-up requests.
        const close = { connection: "close" };
        if (failNext) {
          failNext = false;
          return Response.json({ error: "boom" }, { status: 500, headers: close });
        }
        const data = (body?.input ?? []).map((text, i) => ({ index: i, embedding: VECTORS[text] }));
        if (data.some((d) => !d.embedding)) {
          return Response.json({ error: "unknown text" }, { status: 400, headers: close });
        }
        return Response.json({ data }, { headers: close });
      },
    });
    embedCfg = {
      url: `http://127.0.0.1:${embedServer.port}`,
      model: "mock-embed-1",
      apiKey: "",
      dim: DIM,
    };

    disposable = await createDisposableDb(url!, "hybrid");
    process.env.DATABASE_URL = disposable.url;
    await endDbPools();
    sql = postgres(disposable.url, { max: 2, onnotice: () => {} });
    const appUrl = new URL(disposable.url);
    appUrl.username = "km_app";
    appUrl.password = "km-demo-local";
    app = postgres(appUrl.toString(), { max: 2, onnotice: () => {} });

    await sql`insert into orgs (id, slug, name) values (${ORG}, 'org-h', 'Hybrid Org')`;
    await sql`insert into namespaces (id, org_id, slug, kind) values (${NS}, ${ORG}, 'hybrid', 'project')`;
    await sql`insert into repos (id, org_id, github_full) values (${REPO}, ${ORG}, 'test/hybrid-mind')`;

    // Throwaway mind: two pages with disjoint lexicons.
    mindPath = mkdtempSync(join(tmpdir(), "km-hybrid-mind-"));
    const git = (...args: string[]) => {
      const r = spawnSync("git", args, { cwd: mindPath, encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    git("init", "-q");
    writeFileSync(join(mindPath, "a.md"), `# A\n\n${CONTENT_A}\n`);
    writeFileSync(join(mindPath, "b.md"), `# B\n\n${CONTENT_B}\n`);
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed");

    const stats = await ingestRepo(sql, {
      repoId: REPO,
      namespaceId: NS,
      repoPath: mindPath,
      embed: (texts) => embedTexts(embedCfg, texts),
      embedderVersion: embedCfg.model,
    });
    expect(stats.chunks).toBe(2);
    expect(stats.embedded).toBe(2);
  });

  afterAll(async () => {
    try {
      embedServer?.stop(true);
    } catch {}
    try {
      await endDbPools();
    } catch {}
    try {
      await app?.end();
    } catch {}
    try {
      await sql?.end();
    } catch {}
    try {
      await disposable?.drop();
    } catch (err) {
      console.warn(`failed to drop ${disposable?.name}: ${(err as Error).message}`);
    }
    try {
      rmSync(mindPath, { recursive: true, force: true });
    } catch {}
  }, 20000);

  test("ingest fills chunks.embedding with the configured embedder", async () => {
    const rows = await sql`select embedding is not null as has_vec, embedder_version from chunks order by id`;
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.has_vec).toBe(true);
      expect(r.embedder_version).toBe("mock-embed-1");
    }
  });

  test("FTS-only (no embedder): lexical match wins", async () => {
    const res = await kmSearch(claims, { query: QUERY }, null);
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0].path).toBe("a.md"); // shares lexemes with the query
  });

  test("hybrid: semantic similarity outranks a weak lexical hit", async () => {
    const res = await kmSearch(claims, { query: QUERY }, embed);
    expect(res.hits.length).toBe(2);
    // B shares ZERO lexemes with the query — only its embedding surfaces it,
    // and its ~0.98 cosine beats A's FTS + ~0.2 cosine.
    expect(res.hits[0].path).toBe("b.md");
    expect(res.hits[1].path).toBe("a.md");
  });

  test("embedding endpoint failure degrades to FTS (search never breaks)", async () => {
    failNext = true; // query embedding call will 500
    const res = await kmSearch(claims, { query: QUERY }, embed);
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0].path).toBe("a.md"); // pure-FTS ordering
  });

  test("embedding responses are validated before anything reaches the DB", async () => {
    // Pure client-side guards: wrong dim / wrong count raise before a write;
    // index order is restored (providers may reply out of order). The column
    // itself is vector(1536) — PostgreSQL rejects other dimensions anyway.
    expect(() => validateEmbeddings([{ index: 0, embedding: [0.1, 0.2] }], 1, DIM)).toThrow(/dim/);
    expect(() => validateEmbeddings([], 1, DIM)).toThrow(/1 vectors/);
    const ordered = validateEmbeddings(
      [
        { index: 1, embedding: unit(2) },
        { index: 0, embedding: unit(1) },
      ],
      2,
      DIM,
    );
    expect(ordered[0][1]).toBe(1);
    expect(ordered[1][2]).toBe(1);
  });
});
