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
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveDbUrl } from "../../tests/support/db";
import { loadConfig, DEMO_ORG } from "../src/config";
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
  const repoRoot = join(import.meta.dir, "..", "..");
  const mindPath = join(repoRoot, "demo", "mind");

  async function migrateIfNeeded(): Promise<void> {
    const hasMarker = await admin`select to_regclass('_migrations') as m`;
    if (hasMarker[0]?.m) return;
    const dir = join(repoRoot, "migrations");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      await admin.unsafe(readFileSync(join(dir, f), "utf8"));
    }
  }

  beforeAll(async () => {
    admin = postgres(dbUrl!, { max: 2, onnotice: () => {} });
    // Request-path role must exist with the demo password (CI service
    // containers have no initdb scripts).
    await admin`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'km_app') then
        create role km_app login password 'km-demo-local';
      end if;
    end $$`;
    await migrateIfNeeded();

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

    // Seed the demo mind if missing.
    if (!existsSync(join(mindPath, ".git"))) {
      const res = spawnSync("bun", ["run", join(repoRoot, "scripts", "seed-mind.ts")], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (res.status !== 0) throw new Error(`seed failed: ${res.stderr}`);
    }

    const cfg: ReturnType<typeof loadConfig> = {
      ...loadConfig(),
      mode: "demo",
      mindPath,
      appPassword: "km-demo-local",
    };
    process.env.KM_APP_PASSWORD = "km-demo-local";
    await bootDemo(cfg);
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createFetch(cfg) });
    baseUrl = `http://127.0.0.1:${server.port}/mcp`;
  });

  // Pages a test mutated that must return to their committed baseline, or the
  // suite is not re-runnable. Restored in afterAll: a mid-suite commit moves
  // HEAD past the index and drifts every later read-your-writes assertion.
  const pagesToRestore = new Set<string>();

  afterAll(async () => {
    for (const rel of pagesToRestore) restoreMindPage(rel);
    server?.stop(true);
    await admin?.end({ timeout: 5 });
  }, 20000);

  async function connect(token = "km-demo-local"): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    return client;
  }

  /** Restore a mind page to its committed baseline so the suite stays re-runnable. */
  function restoreMindPage(rel: string): void {
    const head = spawnSync("git", ["log", "-1", "--format=%H", "--", rel], {
      cwd: mindPath,
      encoding: "utf8",
    });
    spawnSync("git", ["checkout", `${head.stdout.trim()}~1`, "--", rel], {
      cwd: mindPath,
      encoding: "utf8",
    });
    spawnSync("git", ["commit", "-q", "-m", `test: restore ${rel} baseline`], {
      cwd: mindPath,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "KontextMind",
        GIT_AUTHOR_EMAIL: "mind@kontextmind.local",
        GIT_COMMITTER_NAME: "KontextMind",
        GIT_COMMITTER_EMAIL: "mind@kontextmind.local",
      },
    });
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
    // Unique per run: this suite commits to the shared demo mind and never
    // GCs, so a fixed title accumulates duplicates until the new draft is
    // pushed past km_search's default limit of 8 and read-your-writes fails
    // for a reason that has nothing to do with read-your-writes.
    const marker = `zt${Date.now().toString(36)}`;
    const res = parse(
      await c.callTool({
        name: "km_append",
        arguments: {
          title: `e2e: bun lockfile workaround ${marker}`,
          content: `On Windows, bun 1.3.10 fails to replace lockfiles; install with --no-save. (${marker})`,
          classification: "project",
        },
      }),
    );
    expect(res.status).toBe("draft");
    expect(res.path).toStartWith("inbox/drafts/");
    expect(res.review_id).toBeTruthy();
    // read-your-writes: immediately searchable
    const found = parse(
      await c.callTool({ name: "km_search", arguments: { query: `bun lockfile workaround ${marker}` } }),
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
    // Restore baseline: the clobber guard is working as designed, so leaving
    // the edge behind would make this suite fail on its second run.
    pagesToRestore.add("decisions/0005-demo-wedge.md");
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
});
