/**
 * Two-tenant isolation harness — CI MERGE BLOCKER.
 *
 * Phase 0 form: asserts RLS denial at the claims/SQL layer.
 * Phase 1a extends this to the full HTTP/MCP path for every km_* endpoint.
 *
 * Fixture: org A (ns-a1, ns-a2), org B (ns-b1). A principal in ns-a1 must be
 * denied ns-a2 and ns-b1 resources on every tenant table. Service kind is
 * denied everywhere.
 *
 * Requires TEST_DATABASE_URL (or DATABASE_URL) pointing at a disposable
 * Postgres 15+ with migrations applied; falls back to the local compose DB.
 * This is a MERGE BLOCKER, so it must never skip silently — it runs, or it
 * fails loudly. Opting out takes an explicit KM_SKIP_DB_TESTS=1.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import postgres from "postgres";
import { resolveDbUrl } from "../support/db";

const url = resolveDbUrl("isolation harness");
const describeMaybe = url ? describe : describe.skip;

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaaaaaa";
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbbbbbb";
const NS_A1 = "ns_a1aaaaaaaaaaaaaaaaaaaaaa";
const NS_A2 = "ns_a2aaaaaaaaaaaaaaaaaaaaaa";
const NS_B1 = "ns_b1bbbbbbbbbbbbbbbbbbbbbbb";
const USER = "user_aaaaaaaaaaaaaaaaaaaaaaa1";

describeMaybe("isolation harness", () => {
  let sql: postgres.Sql; // superuser: fixtures only
  let app: postgres.Sql; // km_app: claims queries — RLS actually applies

  const claims = (namespaces: string[], kind = "human", org = ORG_A) =>
    JSON.stringify({ sub: USER, kind, org, namespaces, roles: {} });

  const asClaims = async (c: string, fn: (tx: postgres.TransactionSql) => Promise<any>) =>
    app.begin(async (tx) => {
      await tx.unsafe(`select set_config('km.claims', $1, true)`, [c]);
      return fn(tx);
    });

  beforeAll(async () => {
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    // Request-path role must exist (fresh CI databases have no initdb scripts).
    await sql`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'km_app') then
        create role km_app login password 'km-demo-local';
      end if;
    end $$`;
    await sql`grant usage on schema public to km_app`;
    await sql`grant select, insert, update, delete on all tables in schema public to km_app`;
    await sql`grant usage on all sequences in schema public to km_app`;
    const appUrl = new URL(url!);
    appUrl.username = "km_app";
    appUrl.password = "km-demo-local";
    app = postgres(appUrl.toString(), { max: 2, onnotice: () => {} });
    // fixture (idempotent)
    await sql`insert into orgs (id, slug, name) values
      (${ORG_A}, 'org-a', 'Org A'), (${ORG_B}, 'org-b', 'Org B')
      on conflict (id) do nothing`;
    await sql`insert into namespaces (id, org_id, slug, kind) values
      (${NS_A1}, ${ORG_A}, 'project-a1', 'project'),
      (${NS_A2}, ${ORG_A}, 'project-a2', 'project'),
      (${NS_B1}, ${ORG_B}, 'project-b1', 'project')
      on conflict (id) do nothing`;
    await sql`insert into repos (id, org_id, github_full) values
      ('repo_aaaaaaaaaaaaaaaaaaaaaaa1', ${ORG_A}, 'test/mind-a')
      on conflict (id) do nothing`;
    await sql`insert into pages (id, repo_id, namespace_id, path, status, commit_sha) values
      ('page_a1aaaaaaaaaaaaaaaaaaaaa1', 'repo_aaaaaaaaaaaaaaaaaaaaaaa1', ${NS_A1}, 'wiki/a1.md', 'verified', 'sha1'),
      ('page_a2aaaaaaaaaaaaaaaaaaaaa1', 'repo_aaaaaaaaaaaaaaaaaaaaaaa1', ${NS_A2}, 'wiki/a2.md', 'verified', 'sha2')
      on conflict (id) do nothing`;
    await sql`insert into invites (id, org_id, email, role, token, invited_by) values
      ('inv_aaaaaaaaaaaaaaaaaaaaaaa1', ${ORG_A}, 'a@example.com', 'member', 'tok_a_fixture', ${USER})
      on conflict (id) do nothing`;
  });

  afterAll(async () => {
    await app?.end();
    await sql?.end();
  });

  test("service kind is denied on tenant tables", async () => {
    const rows = await asClaims(claims([NS_A1], "service"), (tx) =>
      tx`select * from pages`,
    );
    expect(rows.length).toBe(0);
  });

  test("principal sees own namespace pages only", async () => {
    const rows = await asClaims(claims([NS_A1]), (tx) => tx`select * from pages`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.namespace_id).toBe(NS_A1);
    expect(rows.some((r) => r.path === "wiki/a1.md")).toBe(true);
  });

  test("principal is denied sibling namespace (same org)", async () => {
    const rows = await asClaims(claims([NS_A2]), (tx) =>
      tx`select * from pages where namespace_id = ${NS_A1}`,
    );
    expect(rows.length).toBe(0);
  });

  test("principal is denied other org entirely", async () => {
    const rows = await asClaims(claims([NS_B1], "human", ORG_B), (tx) =>
      tx`select * from pages`,
    );
    for (const r of rows) expect(r.namespace_id).toBe(NS_B1);
  });

  test("no claims = no access", async () => {
    const rows = await app.begin(async (tx) => tx`select * from pages`);
    expect(rows.length).toBe(0);
  });

  test("cross-namespace write is denied", async () => {
    await expect(
      asClaims(claims([NS_A1]), (tx) =>
        tx`insert into checkpoints (id, namespace_id, author_id, note)
           values ('cp_deny_test', ${NS_A2}, ${USER}, 'should be denied')`,
      ),
    ).rejects.toThrow();
  });

  test("invites: org A principal sees own invites only", async () => {
    const rows = await asClaims(claims([NS_A1]), (tx) => tx`select * from invites`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.org_id).toBe(ORG_A);
  });

  test("invites: org B principal is denied org A invites", async () => {
    const rows = await asClaims(claims([NS_B1], "human", ORG_B), (tx) => tx`select * from invites`);
    expect(rows.length).toBe(0);
  });

  test("invites: service kind is denied", async () => {
    const rows = await asClaims(claims([NS_A1], "service"), (tx) => tx`select * from invites`);
    expect(rows.length).toBe(0);
  });

  test("invites: no claims = no access", async () => {
    const rows = await app.begin(async (tx) => tx`select * from invites`);
    expect(rows.length).toBe(0);
  });

  test("invites: cross-org write is denied", async () => {
    await expect(
      asClaims(claims([NS_A1]), (tx) =>
        tx`insert into invites (id, org_id, email, role, token, invited_by)
           values ('inv_deny_test', ${ORG_B}, 'b@example.com', 'member', 'tok_deny', ${USER})`,
      ),
    ).rejects.toThrow();
  });

  test("repos: cross-org registration is denied", async () => {
    await expect(
      asClaims(claims([NS_A1]), (tx) =>
        tx`insert into repos (id, org_id, github_full)
           values ('repo_deny_test', ${ORG_B}, 'test/mind-deny')`,
      ),
    ).rejects.toThrow();
  });

  // Phase 1a: repeat every case above through the HTTP/MCP path for each
  // km_* tool (search, read, list, graph, append, review, work, insights).
});
