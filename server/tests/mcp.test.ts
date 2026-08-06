/**
 * End-to-end MCP + isolation test (board requirement: extend the harness to
 * the HTTP path). Boots the real server in-process against a disposable DB,
 * exercises km_* over the MCP SDK client, and asserts cross-tenant denial
 * through the full stack.
 *
 * Skips when no DATABASE_URL/TEST_DATABASE_URL is available.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig, DEMO_ORG } from "../src/config";
import { bootDemo, createFetch } from "../src/app";

const dbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
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

  afterAll(async () => {
    await server?.stop();
    await admin?.end();
  });

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

  test("demo org fixture matches claims (sanity)", () => {
    expect(DEMO_ORG).toBe("org_aaaaaaaaaaaaaaaaaaaaaaaa");
  });
});
