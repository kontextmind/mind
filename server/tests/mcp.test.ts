/**
 * End-to-end MCP + isolation test (board requirement: extend the harness to
 * the HTTP path). Boots the real server in-process against a disposable DB,
 * exercises km_* over the MCP SDK client, and asserts cross-tenant denial
 * through the full stack.
 *
 * Uses TEST_DATABASE_URL/DATABASE_URL, falling back to the local compose DB.
 * Never skips silently: it runs, or it fails loudly. Opting out takes an
 * explicit KM_SKIP_DB_TESTS=1 (see tests/support/db.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveDbUrl, createDisposableDb, type DisposableDb } from "../../tests/support/db";
import { loadConfig, DEMO_ORG, DEMO_NAMESPACE } from "../src/config";
import { bootDemo, createFetch } from "../src/app";

const dbUrl = resolveDbUrl("MCP e2e");
const describeMaybe = dbUrl ? describe : describe.skip;

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbbbbbb";
const NS_B1 = "ns_b1bbbbbbbbbbbbbbbbbbbbbbb";
const REPO_B = "repo_bbbbbbbbbbbbbbbbbbbbbbbb";

describeMaybe("MCP end-to-end + HTTP isolation", () => {
  let server: ReturnType<typeof Bun.serve>;
  let admin: postgres.Sql;
  let baseUrl: string;
  let disposable: DisposableDb;
  const repoRoot = join(import.meta.dir, "..", "..");
  // Disposable mind: this suite commits to whatever mind it is pointed at
  // (drafts, promotions, supersede edges). Pointed at demo/mind it permanently
  // accumulated an e2e draft + promoted page per run — 48 files and 72 review
  // rows before the first GC. Each run now seeds its own throwaway clone from
  // scripts/seed-mind.ts, which produces the same two dated commits, so the
  // fixture is identical but nothing outlives the run.
  const mindPath = mkdtempSync(join(tmpdir(), "km-e2e-mind-"));

  beforeAll(async () => {
    // Disposable database, mirroring the disposable mind: nothing this run
    // writes (review_items, tombstoned pages) outlives it, and no fixture can
    // leak into another run.
    disposable = await createDisposableDb(dbUrl!, "mcp");
    process.env.DATABASE_URL = disposable.url; // bootDemo/loadConfig read this
    admin = postgres(disposable.url, { max: 2, onnotice: () => {} });

    // Second-tenant fixture: org B with a page that shares a search term.
    await admin`insert into orgs (id, slug, name) values (${ORG_B}, 'org-b', 'Org B')
      on conflict (id) do nothing`;
    await admin`insert into namespaces (id, org_id, slug, kind) values (${NS_B1}, ${ORG_B}, 'project-b1', 'project')
      on conflict (id) do nothing`;
    await admin`insert into repos (id, org_id, github_full) values (${REPO_B}, ${ORG_B}, 'test/mind-b')
      on conflict (id) do nothing`;
    await admin`insert into pages (id, repo_id, namespace_id, path, title, status, commit_sha)
      values ('page_b1aaaaaaaaaaaaaaaaaaaaa1', ${REPO_B}, ${NS_B1}, 'wiki/secret-b.md', 'KontextMind secret tenant B page', 'verified', 'shab')
      on conflict (id) do nothing`;
    await admin`insert into chunks (id, page_id, namespace_id, ord, content, commit_sha)
      values ('page_b1aaaaaaaaaaaaaaaaaaaaa1_0', 'page_b1aaaaaaaaaaaaaaaaaaaaa1', ${NS_B1}, 0,
              'KontextMind tenant B confidential content about supabase and postgres', 'shab')
      on conflict (id) do nothing`;

    // Seed this run's throwaway mind. Always seeds: the temp dir is new, and
    // seed-mind.ts wipes and re-creates its target with deterministic dated
    // commits, so every run starts from a byte-identical fixture.
    const res = spawnSync("bun", ["run", join(repoRoot, "scripts", "seed-mind.ts"), mindPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (res.status !== 0) throw new Error(`seed failed: ${res.stderr}`);

    const cfg: ReturnType<typeof loadConfig> = {
      ...loadConfig(),
      mode: "demo",
      mindPath,
      appPassword: "km-demo-local",
    };
    process.env.KM_APP_PASSWORD = "km-demo-local";
    await bootDemo(cfg);

    // Insight fixtures AFTER bootDemo: DEMO_NAMESPACE only exists once the
    // demo org is seeded. Detectors file these in production; km_insights
    // under test only reads/dismisses.
    await admin`insert into insights (id, namespace_id, kind, title, evidence, confidence) values
      ('ins_aaaaaaaaaaaaaaaaaaaaaaa1', ${DEMO_NAMESPACE}, 'loop', 'fixture loop insight', '{"subject":"fixture:1"}', 0.7),
      ('ins_aaaaaaaaaaaaaaaaaaaaaaa2', ${DEMO_NAMESPACE}, 'gap', 'fixture gap insight', '{"subject":"fixture:2"}', 0.6)
      on conflict (id) do nothing`;
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createFetch(cfg) });
    baseUrl = `http://127.0.0.1:${server.port}/mcp`;
  });

  afterAll(async () => {
    // Each step is independent. A throw in one must not strand the others:
    // rmSync on the seeded git repo can fail with EBUSY/EPERM on Windows, and
    // when it ran before the drop it left a stray km_test_* database behind.
    // The database is the costlier leak, so it goes first.
    try {
      server?.stop(true);
    } catch {}
    try {
      await admin?.end({ timeout: 5 });
    } catch {}
    try {
      await disposable?.drop();
    } catch (err) {
      console.warn(`failed to drop ${disposable?.name}: ${(err as Error).message}`);
    }
    try {
      rmSync(mindPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (err) {
      console.warn(`failed to remove ${mindPath}: ${(err as Error).message}`);
    }
  }, 20000);

  async function connect(token = "km-demo-local"): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    return client;
  }

  function parse(res: Awaited<ReturnType<Client["callTool"]>>): any {
    const text = (res.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    return JSON.parse(text);
  }

  test("rejects bad token with 401", async () => {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  test("km_status: fresh index, session issued, trust mode", async () => {
    const c = await connect();
    const res = parse(await c.callTool({ name: "km_status", arguments: {} }));
    expect(res.session_id).toMatch(/^km_ses_[0-9a-z]{26}$/);
    expect(res.trust_mode).toBe("local-demo");
    expect(res.index_fresh).toBe(true);
    expect(res.indexed_sha).toBe(res.head_sha);
    await c.close();
  });

  test("km_status beacon: skill is echoed AND persisted to skill_use", async () => {
    const c = await connect();
    const res = parse(
      await c.callTool({ name: "km_status", arguments: { skill: "mind-query" } }),
    );
    expect(res.beacon).toEqual({ skill: "mind-query", provenance: "beacon" });
    const rows = await admin`select skill, provenance, org_id from skill_use
      where session_id = ${res.session_id} and skill = 'mind-query'`;
    expect(rows.length).toBe(1);
    expect(rows[0].provenance).toBe("beacon");
    expect(rows[0].org_id).toBe(DEMO_ORG);
    await c.close();
  });

  test("wow beat: superseded Supabase page is flagged", async () => {
    const c = await connect();
    const res = parse(
      await c.callTool({ name: "km_search", arguments: { query: "Supabase control plane" } }),
    );
    const stale = res.hits.find((h: any) => h.path === "decisions/0006-hosting-supabase.md");
    expect(stale).toBeDefined();
    expect(stale.superseded_by).toBe("decisions/0007-single-postgres.md");
    expect(stale.status).toBe("suspect");
    const fresh = res.hits.find((h: any) => h.path === "decisions/0007-single-postgres.md");
    expect(fresh?.superseded_by ?? null).toBeNull();
    await c.close();
  });

  test("search returns provenance on every hit", async () => {
    const c = await connect();
    const res = parse(
      await c.callTool({ name: "km_search", arguments: { query: "persistent mind agent" } }),
    );
    expect(res.hits.length).toBeGreaterThan(0);
    for (const h of res.hits) {
      expect(h.commit_sha).toMatch(/^[0-9a-f]{40}$/);
      expect(h.indexed_at).toBeTruthy();
      expect(h.path).toBeTruthy();
    }
    await c.close();
  });

  test("HTTP isolation: tenant B content is invisible to the demo principal", async () => {
    const c = await connect();
    // Search with terms that only exist in tenant B's chunk.
    const res = parse(
      await c.callTool({
        name: "km_search",
        arguments: { query: "tenant B confidential" },
      }),
    );
    for (const h of res.hits) expect(h.path).not.toBe("wiki/secret-b.md");
    // Direct read is denied (server returns not_found for invisible paths).
    const read = parse(
      await c.callTool({ name: "km_read", arguments: { path: "wiki/secret-b.md" } }),
    );
    expect(read.page ?? null).toBeNull();
    expect(read.error ?? null).toBe("not_found");
    // List contains no tenant B paths.
    const list = parse(await c.callTool({ name: "km_list", arguments: {} }));
    for (const p of list.pages) expect(p.path).not.toContain("secret-b");
    await c.close();
  });

  test("km_append: clean learning → draft, review item, read-your-writes", async () => {
    const c = await connect();
    const res = parse(
      await c.callTool({
        name: "km_append",
        arguments: {
          title: "e2e: bun lockfile workaround",
          content: "On Windows, bun 1.3.10 fails to replace lockfiles; install with --no-save.",
          classification: "project",
        },
      }),
    );
    expect(res.status).toBe("draft");
    expect(res.path).toStartWith("inbox/drafts/");
    expect(res.review_id).toBeTruthy();
    // read-your-writes: immediately searchable
    const found = parse(
      await c.callTool({ name: "km_search", arguments: { query: "bun lockfile workaround" } }),
    );
    expect(found.hits.some((h: any) => h.path === res.path)).toBe(true);
    // review queue shows it pending
    const list = parse(await c.callTool({ name: "km_review", arguments: { action: "list" } }));
    expect(list.items.some((i: any) => i.id === res.review_id && !i.resolved_at)).toBe(true);
    await c.close();
  });

  test("km_append: secret content is quarantined, never committed", async () => {
    const c = await connect();
    const res = parse(
      await c.callTool({
        name: "km_append",
        arguments: {
          title: "e2e: db credentials",
          content: "The db url is postgres://admin:hunter2secret@db:5432/app for prod.",
        },
      }),
    );
    expect(res.status).toBe("quarantined");
    expect(res.rules).toContain("connection-string");
    // not searchable — nothing was committed
    const found = parse(
      await c.callTool({ name: "km_search", arguments: { query: "hunter2secret prod" } }),
    );
    expect(found.hits.length).toBe(0);
    // quarantine shows in the review queue as suspicious
    const list = parse(
      await c.callTool({ name: "km_review", arguments: { action: "list", kind: "suspicious" } }),
    );
    expect(list.items.some((i: any) => i.id === res.review_id)).toBe(true);
    await c.close();
  });

  test("km_append: review body is stored as a jsonb object, not a string", async () => {
    // Regression: `cast(${JSON.stringify(x)} as jsonb)` double-encodes, because
    // postgres.js JSON.stringify's the value once PG infers the param as jsonb.
    // The body landed as a jsonb *string scalar*, so body->>'draft_path' was
    // NULL and no draft could ever be promoted. Covers both insert sites.
    const c = await connect();
    const learning = parse(
      await c.callTool({
        name: "km_append",
        arguments: { title: "e2e: jsonb shape check", content: "Body must be a jsonb object." },
      }),
    );
    const quarantined = parse(
      await c.callTool({
        name: "km_append",
        arguments: {
          title: "e2e: jsonb shape check secret",
          content: "url postgres://admin:hunter2secret@db:5432/app",
        },
      }),
    );
    expect(quarantined.status).toBe("quarantined");

    const rows = await admin`
      select id, jsonb_typeof(body) as jtype, body->>'draft_path' as draft_path
      from review_items where id in (${learning.review_id}, ${quarantined.review_id})`;
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.jtype).toBe("object");
    const learningRow = rows.find((r: any) => r.id === learning.review_id);
    expect(learningRow.draft_path).toBe(learning.path);
    await c.close();
  });

  test("km_append: supersede edge is NOT applied at draft time", async () => {
    // Regression: a curated decision was repointed at an unreviewed inbox
    // draft, clobbering an existing edge. Nothing may change until promotion.
    const c = await connect();
    const target = join(mindPath, "decisions", "0005-demo-wedge.md");
    const before = readFileSync(target, "utf8");
    const res = parse(
      await c.callTool({
        name: "km_append",
        arguments: {
          title: "e2e: supersede timing",
          content: "This draft claims to supersede the demo wedge decision.",
          supersedes: "decisions/0005-demo-wedge.md",
        },
      }),
    );
    expect(res.status).toBe("draft");
    expect(readFileSync(target, "utf8")).toBe(before);

    // ...and skipping it must still leave the target untouched.
    const skipped = parse(
      await c.callTool({
        name: "km_review",
        arguments: {
          action: "resolve",
          id: res.review_id,
          verdict: "skip",
          reason: "e2e: not wanted",
        },
      }),
    );
    expect(skipped.verdict).toBe("skip");
    expect(readFileSync(target, "utf8")).toBe(before);
    await c.close();
  });

  test("km_review: promote applies the supersede edge to the promoted page", async () => {
    const c = await connect();
    const target = join(mindPath, "decisions", "0005-demo-wedge.md");
    const res = parse(
      await c.callTool({
        name: "km_append",
        arguments: {
          title: "e2e: supersede on promote",
          content: "Replacement for the demo wedge decision.",
          supersedes: "decisions/0005-demo-wedge.md",
        },
      }),
    );
    const promoted = parse(
      await c.callTool({
        name: "km_review",
        arguments: { action: "resolve", id: res.review_id, verdict: "promote" },
      }),
    );
    expect(promoted.promoted_to).toStartWith("projects/demo/learnings/");
    const fm = readFileSync(target, "utf8");
    expect(fm).toContain(`superseded_by: ${promoted.promoted_to}`);
    expect(fm).not.toContain("superseded_by: inbox/");
    await c.close();
  });

  test("km_append: refuses to clobber an existing supersede edge", async () => {
    // 0006 already points at 0007 from seed; appending must not repoint it.
    const c = await connect();
    const target = join(mindPath, "decisions", "0006-hosting-supabase.md");
    const before = readFileSync(target, "utf8");
    expect(before).toContain("superseded_by: decisions/0007-single-postgres.md");
    const attempt = await c.callTool({
      name: "km_append",
      arguments: {
        title: "e2e: clobber attempt",
        content: "Trying to repoint an already-superseded decision.",
        supersedes: "decisions/0006-hosting-supabase.md",
      },
    });
    // Refused at append time: no draft, no queue entry, no commit.
    expect(attempt.isError).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(before);
    const queued = parse(
      await c.callTool({ name: "km_review", arguments: { action: "list" } }),
    ).items.find((i: any) => i.title === "e2e: clobber attempt");
    expect(queued).toBeUndefined();
    await c.close();
  });

  test("km_review: skip requires a reason", async () => {
    const c = await connect();
    const list = parse(await c.callTool({ name: "km_review", arguments: { action: "list" } }));
    const pending = list.items.find((i: any) => !i.resolved_at && i.kind === "learning");
    expect(pending).toBeDefined();
    const res = await c.callTool({
      name: "km_review",
      arguments: { action: "resolve", id: pending.id, verdict: "skip" },
    });
    expect(res.isError).toBe(true);
    await c.close();
  });

  test("km_review: promote moves draft to curated tree as verified", async () => {
    const c = await connect();
    const list = parse(await c.callTool({ name: "km_review", arguments: { action: "list" } }));
    const pending = list.items.find((i: any) => !i.resolved_at && i.kind === "learning");
    expect(pending).toBeDefined();
    const res = parse(
      await c.callTool({
        name: "km_review",
        arguments: { action: "resolve", id: pending.id, verdict: "promote" },
      }),
    );
    expect(res.verdict).toBe("promote");
    expect(res.promoted_to).toStartWith("projects/demo/learnings/");
    // promoted page is searchable as verified
    const read = parse(await c.callTool({ name: "km_read", arguments: { path: res.promoted_to } }));
    expect(read.status).toBe("verified");
    await c.close();
  });

  test("km_projects: lists the demo project with freshness and active id", async () => {
    const c = await connect();
    const res = parse(await c.callTool({ name: "km_projects", arguments: {} }));
    expect(res.count).toBeGreaterThan(0);
    const demo = res.projects.find((p: any) => p.github_full === "local/demo-mind");
    expect(demo).toBeDefined();
    expect(res.active).toBe(demo.id);
    expect(demo.head_sha).toMatch(/^[0-9a-f]{40}$/);
    await c.close();
  });

  test("km_chat: evidence pack with tool events, references, and null answer", async () => {
    const c = await connect();
    const res = parse(
      await c.callTool({ name: "km_chat", arguments: { question: "why did KontextMind drop Supabase" } }),
    );
    expect(res.answer).toBeNull();
    expect(res.synthesis).toBe("client");
    expect(res.evidence.length).toBeGreaterThan(0);
    expect(res.tool_events[0].tool).toBe("km_search");
    expect(res.references.length).toBeGreaterThan(0);
    for (const r of res.references) expect(r.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(res.usage.evidence_chunks).toBe(res.evidence.length);
    await c.close();
  });

  test("km_chat deep mode runs graph expansion", async () => {
    const c = await connect();
    const res = parse(
      await c.callTool({
        name: "km_chat",
        arguments: { question: "hosting decision single postgres", mode: "deep" },
      }),
    );
    expect(res.mode).toBe("deep");
    const tools = res.tool_events.map((e: any) => e.tool);
    expect(tools).toContain("km_search");
    expect(tools).toContain("km_graph_expand");
    await c.close();
  });

  test("km_graph: wikilink neighborhood at depth 1 and 2", async () => {
    const c = await connect();
    const d1 = parse(
      await c.callTool({ name: "km_graph", arguments: { path: "decisions/0007-single-postgres.md" } }),
    );
    expect(
      d1.edges.some(
        (e: any) =>
          e.from_page === "decisions/0007-single-postgres.md" &&
          e.to_page === "decisions/0006-hosting-supabase.md",
      ),
    ).toBe(true);
    expect(d1.nodes.some((n: any) => n.path === "decisions/0006-hosting-supabase.md")).toBe(true);
    // depth 2 reaches 0005 via 0006
    const d2 = parse(
      await c.callTool({
        name: "km_graph",
        arguments: { path: "decisions/0007-single-postgres.md", depth: 2 },
      }),
    );
    expect(d2.nodes.some((n: any) => n.path === "decisions/0005-demo-wedge.md")).toBe(true);
    for (const e of d2.edges) expect(e.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    await c.close();
  });

  test("km_reindex: no drift after boot ingest", async () => {
    const c = await connect();
    const res = parse(await c.callTool({ name: "km_reindex", arguments: {} }));
    expect(res.drifted).toBe(false);
    expect(res.repaired).toBe(false);
    expect(res.headSha).toMatch(/^[0-9a-f]{40}$/);
    await c.close();
  });

  test("km_invite: issues a link-only invite; bad email is an error", async () => {
    const c = await connect();
    const res = parse(
      await c.callTool({ name: "km_invite", arguments: { email: "newdev@example.com", role: "member" } }),
    );
    expect(res.invite_id).toMatch(/^inv_/);
    expect(res.delivery).toBe("link");
    expect(res.accept_url).toContain("token=kmi_");
    const bad = await c.callTool({ name: "km_invite", arguments: { email: "not-an-email" } });
    expect(bad.isError).toBe(true);
    await c.close();
  });

  test("km_project_add: register-only project appears in km_projects", async () => {
    const c = await connect();
    const res = parse(
      await c.callTool({ name: "km_project_add", arguments: { name: "e2e-registered-project" } }),
    );
    expect(res.project.id).toMatch(/^repo_/);
    expect(res.indexed).toBeNull();
    const list = parse(await c.callTool({ name: "km_projects", arguments: {} }));
    expect(list.projects.some((p: any) => p.id === res.project.id)).toBe(true);
    await c.close();
  });

  test("demo org fixture matches claims (sanity)", () => {
    expect(DEMO_ORG).toBe("org_aaaaaaaaaaaaaaaaaaaaaaaa");
  });

  test("km_insights: lists pending insights with evidence, kind filter works", async () => {
    const c = await connect();
    const res = parse(await c.callTool({ name: "km_insights", arguments: {} }));
    expect(res.count).toBe(2);
    for (const i of res.insights) {
      expect(i.verdict).toBe("pending");
      expect(i.namespace_id).toBe(DEMO_NAMESPACE);
      expect(i.evidence.subject).toMatch(/^fixture:/);
    }
    const gaps = parse(await c.callTool({ name: "km_insights", arguments: { kind: "gap" } }));
    expect(gaps.count).toBe(1);
    expect(gaps.insights[0].kind).toBe("gap");
    await c.close();
  });

  test("km_insights: dismiss requires verdict; dismissed/snoozed require reason", async () => {
    const c = await connect();
    const noVerdict = await c.callTool({
      name: "km_insights",
      arguments: { action: "dismiss", id: "ins_aaaaaaaaaaaaaaaaaaaaaaa1" },
    });
    expect(noVerdict.isError).toBe(true);
    expect(parse(noVerdict).error).toContain("verdict");
    const noReason = await c.callTool({
      name: "km_insights",
      arguments: { action: "dismiss", id: "ins_aaaaaaaaaaaaaaaaaaaaaaa1", verdict: "dismissed" },
    });
    expect(noReason.isError).toBe(true);
    expect(parse(noReason).error).toContain("reason");
    await c.close();
  });

  test("km_insights: dismiss records verdict and removes from list; unknown id is not_found", async () => {
    const c = await connect();
    const res = parse(
      await c.callTool({
        name: "km_insights",
        arguments: {
          action: "dismiss",
          id: "ins_aaaaaaaaaaaaaaaaaaaaaaa1",
          verdict: "accepted",
        },
      }),
    );
    expect(res.dismissed.verdict).toBe("accepted");
    const rows = await admin`select verdict from insights where id = 'ins_aaaaaaaaaaaaaaaaaaaaaaa1'`;
    expect(rows[0].verdict).toBe("accepted");
    const after = parse(await c.callTool({ name: "km_insights", arguments: {} }));
    expect(after.count).toBe(1);
    expect(after.insights[0].id).toBe("ins_aaaaaaaaaaaaaaaaaaaaaaa2");
    const ghost = parse(
      await c.callTool({
        name: "km_insights",
        arguments: { action: "dismiss", id: "ins_doesnotexist", verdict: "snoozed", reason: "later" },
      }),
    );
    expect(ghost.error).toBe("not_found");
    await c.close();
  });

  test("km_work_update: checkpoint with TTL + status appears in km_work_current", async () => {
    const c = await connect();
    const res = parse(
      await c.callTool({
        name: "km_work_update",
        arguments: { task_ref: "LIN-42", note: "migrated indexer to blob cache", status: "in_progress" },
      }),
    );
    expect(res.checkpoint.id).toMatch(/^cp_/);
    expect(res.checkpoint.status).toBe("in_progress");
    // TTL ~90d: expires_at is in the future, well beyond now.
    expect(new Date(res.checkpoint.expires_at).getTime()).toBeGreaterThan(Date.now() + 80 * 864e5);
    const cur = parse(await c.callTool({ name: "km_work_current", arguments: {} }));
    expect(cur.trackers.connected).toBe(false); // honest: no integration yet
    const cp = cur.checkpoints.find((x: any) => x.task_ref === "LIN-42");
    expect(cp?.note).toBe("migrated indexer to blob cache");
    expect(cp?.status).toBe("in_progress");
    await c.close();
  });

  test("km_work_update: gate 2 rejects secrets — never stored", async () => {
    const c = await connect();
    const res = await c.callTool({
      name: "km_work_update",
      arguments: { task_ref: "LIN-43", note: "use token ghp_0000000000000000000000000000000FAKE0 for ci" },
    });
    expect(res.isError).toBe(true);
    expect(parse(res).error).toContain("secret_gate");
    const rows = await admin`select id from checkpoints where task_ref = 'LIN-43'`;
    expect(rows.length).toBe(0);
    await c.close();
  });

  test("km_work_update: size-capped note is rejected", async () => {
    const c = await connect();
    const res = await c.callTool({
      name: "km_work_update",
      arguments: { note: "x".repeat(8001) },
    });
    expect(res.isError).toBe(true);
    expect(parse(res).error).toContain("8000");
    await c.close();
  });

  test("km_handoff_save/load: state + next_steps round-trip; claim lease acquired", async () => {
    const c = await connect();
    const saved = parse(
      await c.callTool({
        name: "km_handoff_save",
        arguments: {
          task_ref: "LIN-44",
          state: { branch: "feat/x", done: ["ingest"], blocked_on: "review" },
          next_steps: ["run isolation harness", "open PR"],
        },
      }),
    );
    expect(saved.id).toMatch(/^ho_/);
    expect(saved.existing).toBe(false);

    const loaded = parse(
      await c.callTool({ name: "km_handoff_load", arguments: { id: saved.id, claim: true } }),
    );
    expect(loaded.handoff.state.blocked_on).toBe("review");
    expect(loaded.handoff.next_steps).toEqual(["run isolation harness", "open PR"]);
    expect(loaded.claim.acquired).toBe(true);
    expect(new Date(loaded.claim.lease_expires).getTime()).toBeGreaterThan(Date.now() + 3 * 36e5);

    // Claimed handoff no longer counts as open for others; the caller still
    // sees it in their work context.
    const cur = parse(await c.callTool({ name: "km_work_current", arguments: {} }));
    expect(cur.open_handoffs.some((h: any) => h.id === saved.id)).toBe(true);
    await c.close();
  });

  test("km_handoff_load: live foreign lease is respected; stale lease is takeable", async () => {
    const c = await connect();
    const saved = parse(
      await c.callTool({
        name: "km_handoff_save",
        arguments: { task_ref: "LIN-45", state: { step: 1 }, next_steps: ["continue"] },
      }),
    );
    // Simulate another principal holding a live lease.
    await admin`update handoffs set claimed_by = 'agent-other', claimed_at = now(),
      lease_expires = now() + interval '1 hour' where id = ${saved.id}`;
    const blocked = parse(
      await c.callTool({ name: "km_handoff_load", arguments: { id: saved.id, claim: true } }),
    );
    expect(blocked.claim.acquired).toBe(false);
    expect(blocked.claim.claimed_by).toBe("agent-other");
    // Lease expires → takeover succeeds (stale claims release).
    await admin`update handoffs set lease_expires = now() - interval '1 minute' where id = ${saved.id}`;
    const taken = parse(
      await c.callTool({ name: "km_handoff_load", arguments: { id: saved.id, claim: true } }),
    );
    expect(taken.claim.acquired).toBe(true);
    const rows = await admin`select claimed_by from handoffs where id = ${saved.id}`;
    expect(rows[0].claimed_by).not.toBe("agent-other");
    await c.close();
  });

  test("km_handoff_save: idempotency key returns the same handoff", async () => {
    const c = await connect();
    const args = {
      task_ref: "LIN-46",
      state: { v: 1 },
      next_steps: ["go"],
      idempotency_key: "idem-46",
    };
    const first = parse(await c.callTool({ name: "km_handoff_save", arguments: args }));
    const second = parse(await c.callTool({ name: "km_handoff_save", arguments: args }));
    expect(second.id).toBe(first.id);
    expect(second.existing).toBe(true);
    await c.close();
  });

  test("km_handoff_load: unknown id is not_found", async () => {
    const c = await connect();
    const res = parse(await c.callTool({ name: "km_handoff_load", arguments: { id: "ho_missing" } }));
    expect(res.error).toBe("not_found");
    await c.close();
  });

  test("km_event: low-cardinality rows emitted — raw args never stored", async () => {
    const c = await connect();
    const RAW = "zebrafish-quorum-777";
    parse(await c.callTool({ name: "km_search", arguments: { query: RAW } }));
    parse(await c.callTool({ name: "km_read", arguments: { path: "wiki/does-not-exist.md" } }));
    parse(await c.callTool({
      name: "km_work_update",
      arguments: { task_ref: "EVT-1", note: "event test checkpoint" },
    }));
    const kinds = await admin`select kind from km_event`;
    const kindSet = new Set(kinds.map((r) => r.kind as string));
    expect(kindSet.has("search")).toBe(true);
    expect(kindSet.has("read")).toBe(true);
    expect(kindSet.has("checkpoint")).toBe(true);
    // Privacy contract (docs/session-spine.md): no payload may carry the raw
    // query text — tool + args-hash + counters only.
    const leaked = await admin`select count(*)::int as n from km_event
      where payload::text like ${`%${RAW}%`}`;
    expect(leaked[0].n).toBe(0);
    await c.close();
  });

  test("km_event: empty-search streak files a gap insight at the km_status heartbeat", async () => {
    const c = await connect();
    // Three consecutive zero-hit searches (earlier successful searches in
    // this suite precede the streak — a past hit resets nothing forward).
    for (const q of ["flurbognost-9", "quuxmeister-42", "zantastic-77"]) {
      parse(await c.callTool({ name: "km_search", arguments: { query: q } }));
    }
    parse(await c.callTool({ name: "km_status", arguments: {} })); // heartbeat → detectors
    const gaps = parse(await c.callTool({ name: "km_insights", arguments: { kind: "gap" } }));
    const churn = gaps.insights.filter((i: any) => i.title.includes("empty searches"));
    expect(churn.length).toBe(1);
    expect(churn[0].evidence.searches).toBeGreaterThanOrEqual(3);
    // Pull-only dedupe: another heartbeat files no duplicate.
    parse(await c.callTool({ name: "km_status", arguments: {} }));
    const again = parse(await c.callTool({ name: "km_insights", arguments: { kind: "gap" } }));
    expect(again.insights.filter((i: any) => i.title.includes("empty searches")).length).toBe(1);
    await c.close();
  });

  // ------------------------------------------------------------------ /v1
  // The native transport (CLI fast path) wraps the SAME dispatch as MCP:
  // same tools, same args, same responses — one source of truth.

  const v1 = async (tool: string, args: Record<string, unknown> = {}, token = "km-demo-local") => {
    const res = await fetch(baseUrl.replace(/\/mcp$/, "") + "/v1/call", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool, args }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  test("/v1/call parity: same dispatch as MCP, identical results", async () => {
    const c = await connect();
    const viaMcp = parse(
      await c.callTool({ name: "km_search", arguments: { query: "Supabase control plane" } }),
    );
    await c.close();
    const viaV1 = await v1("km_search", { query: "Supabase control plane" });
    expect(viaV1.status).toBe(200);
    expect(viaV1.body.ok).toBe(true);
    const pathsV1 = (viaV1.body.result.hits ?? []).map((h: any) => h.path).sort();
    const pathsMcp = (viaMcp.hits ?? []).map((h: any) => h.path).sort();
    expect(pathsV1).toEqual(pathsMcp);
    expect(pathsV1.length).toBeGreaterThan(0);
  });

  test("/v1/call: auth, protocol errors, and tool errors", async () => {
    expect((await v1("km_search", { query: "x" }, "wrong-token")).status).toBe(401);
    const badJson = await fetch(baseUrl.replace(/\/mcp$/, "") + "/v1/call", {
      method: "POST",
      headers: { authorization: "Bearer km-demo-local", "content-type": "application/json" },
      body: "{",
    });
    expect(badJson.status).toBe(400);
    const unknown = await v1("km_nope");
    expect(unknown.status).toBe(200);
    expect(unknown.body.ok).toBe(false);
    expect(unknown.body.result.error).toContain("unknown tool");
  });

  test("CLI fast path: kontext search runs over /v1 end to end", async () => {
    const { spawnSync } = await import("node:child_process");
    const res = spawnSync(
      "bun",
      ["run", join(repoRoot, "cli", "src", "index.ts"), "search", "Supabase", "control", "plane"],
      { encoding: "utf8", env: { ...process.env, KM_URL: baseUrl, KM_TOKEN: "km-demo-local" } },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("decisions/");
  });
});
