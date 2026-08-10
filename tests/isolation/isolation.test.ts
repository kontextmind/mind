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
import { resolveDbUrl, createDisposableDb, type DisposableDb } from "../support/db";

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
  let disposable: DisposableDb;

  const claims = (namespaces: string[], kind = "human", org = ORG_A) =>
    JSON.stringify({ sub: USER, kind, org, namespaces, roles: {} });

  const asClaims = async (c: string, fn: (tx: postgres.TransactionSql) => Promise<any>) =>
    app.begin(async (tx) => {
      await tx.unsafe(`select set_config('km.claims', $1, true)`, [c]);
      return fn(tx);
    });

  beforeAll(async () => {
    // Disposable database: this harness writes org A/B fixtures, which used to
    // persist in the shared DB and surface as phantom pages (wiki/a1.md) in
    // km_list long after the run. createDisposableDb applies the migrations —
    // this suite never ran them itself and relied on the DB already being
    // migrated.
    disposable = await createDisposableDb(url!, "isolation");
    sql = postgres(disposable.url, { max: 2, onnotice: () => {} });
    const appUrl = new URL(disposable.url);
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
    // Evidence spine fixtures (webhook join reads: git_evidence,
    // km_unresolved_trailers are org-scoped via their repos).
    await sql`insert into km_sessions (id, org_id, principal) values
      ('km_ses_' || repeat('e', 26), ${ORG_A}, 'agent-e')
      on conflict (id) do nothing`;
    await sql`insert into git_evidence (session_id, repo_id, sha) values
      ('km_ses_' || repeat('e', 26), 'repo_aaaaaaaaaaaaaaaaaaaaaaa1', repeat('e', 40))
      on conflict (repo_id, sha, session_id) do nothing`;
    await sql`insert into km_unresolved_trailers (repo_id, sha, trailer) values
      ('repo_aaaaaaaaaaaaaaaaaaaaaaa1', repeat('e', 40), 'km_ses_' || repeat('9', 26))
      on conflict do nothing`;
    await sql`insert into insights (id, namespace_id, kind, title, evidence) values
      ('ins_a1aaaaaaaaaaaaaaaaaaaaa1', ${NS_A1}, 'loop', 'org A loop insight', '{"subject":"fixture"}'),
      ('ins_a2aaaaaaaaaaaaaaaaaaaaa1', ${NS_A2}, 'gap', 'org A sibling insight', '{"subject":"fixture"}')
      on conflict (id) do nothing`;
    await sql`insert into checkpoints (id, namespace_id, task_ref, author_id, note) values
      ('cp_a1aaaaaaaaaaaaaaaaaaaaa1', ${NS_A1}, 'LIN-1', ${USER}, 'org A checkpoint')
      on conflict (id) do nothing`;
    await sql`insert into handoffs (id, namespace_id, task_ref, author_id, state) values
      ('ho_a1aaaaaaaaaaaaaaaaaaaaa1', ${NS_A1}, 'LIN-1', ${USER}, '{"step":1}')
      on conflict (id) do nothing`;
    await sql`insert into km_event (session_id, org_id, kind, payload) values
      ('km_ses_' || repeat('e', 26), ${ORG_A}, 'search', '{"hits": 0}')
      on conflict do nothing`;
  });

  afterAll(async () => {
    // Independent steps: a throw while closing a pool must not skip the drop
    // and strand a km_test_* database.
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
  }, 20000);

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

  test("git_evidence: org-scoped reads (own org visible, cross-org denied)", async () => {
    const own = await asClaims(claims([NS_A1]), (tx) => tx`select * from git_evidence`);
    expect(own.length).toBeGreaterThan(0);
    for (const r of own) expect(r.repo_id).toBe("repo_aaaaaaaaaaaaaaaaaaaaaaa1");
    const crossOrg = await asClaims(claims([NS_B1], "human", ORG_B), (tx) =>
      tx`select * from git_evidence`,
    );
    expect(crossOrg.length).toBe(0);
    const anon = await app.begin(async (tx) => tx`select * from git_evidence`);
    expect(anon.length).toBe(0);
  });

  test("git_evidence: claims-bound writes are denied (webhook-only population)", async () => {
    await expect(
      asClaims(claims([NS_A1]), (tx) =>
        tx`insert into git_evidence (session_id, repo_id, sha) values
           ('km_ses_' || repeat('e', 26), 'repo_aaaaaaaaaaaaaaaaaaaaaaa1', repeat('d', 40))`,
      ),
    ).rejects.toThrow();
  });

  test("km_unresolved_trailers: org-scoped reads (own org visible, cross-org denied)", async () => {
    const own = await asClaims(claims([NS_A1]), (tx) =>
      tx`select * from km_unresolved_trailers`,
    );
    expect(own.length).toBeGreaterThan(0);
    for (const r of own) expect(r.repo_id).toBe("repo_aaaaaaaaaaaaaaaaaaaaaaa1");
    const crossOrg = await asClaims(claims([NS_B1], "human", ORG_B), (tx) =>
      tx`select * from km_unresolved_trailers`,
    );
    expect(crossOrg.length).toBe(0);
    const anon = await app.begin(async (tx) => tx`select * from km_unresolved_trailers`);
    expect(anon.length).toBe(0);
  });

  test("km_unresolved_trailers: claims-bound writes are denied (webhook-only)", async () => {
    await expect(
      asClaims(claims([NS_A1]), (tx) =>
        tx`insert into km_unresolved_trailers (repo_id, sha, trailer) values
           ('repo_aaaaaaaaaaaaaaaaaaaaaaa1', repeat('d', 40), 'km_ses_' || repeat('8', 26))`,
      ),
    ).rejects.toThrow();
  });

  test("insights: namespace-scoped reads (own visible, sibling + cross-org + anon denied)", async () => {
    const own = await asClaims(claims([NS_A1]), (tx) => tx`select * from insights`);
    expect(own.length).toBe(1);
    expect(own[0].namespace_id).toBe(NS_A1);
    const sibling = await asClaims(claims([NS_A1]), (tx) =>
      tx`select * from insights where namespace_id = ${NS_A2}`,
    );
    expect(sibling.length).toBe(0);
    const crossOrg = await asClaims(claims([NS_B1], "human", ORG_B), (tx) =>
      tx`select * from insights`,
    );
    expect(crossOrg.length).toBe(0);
    const anon = await app.begin(async (tx) => tx`select * from insights`);
    expect(anon.length).toBe(0);
  });

  test("insights: cross-namespace write is denied", async () => {
    await expect(
      asClaims(claims([NS_A1]), (tx) =>
        tx`insert into insights (id, namespace_id, kind, title)
           values ('ins_deny_test', ${NS_A2}, 'loop', 'should be denied')`,
      ),
    ).rejects.toThrow();
  });

  test("insights: service kind is denied", async () => {
    const rows = await asClaims(claims([NS_A1], "service"), (tx) => tx`select * from insights`);
    expect(rows.length).toBe(0);
  });

  test("checkpoints: namespace-scoped reads (own visible, sibling + cross-org + anon denied)", async () => {
    const own = await asClaims(claims([NS_A1]), (tx) => tx`select * from checkpoints`);
    expect(own.length).toBe(1);
    expect(own[0].namespace_id).toBe(NS_A1);
    const sibling = await asClaims(claims([NS_A2]), (tx) =>
      tx`select * from checkpoints where namespace_id = ${NS_A1}`,
    );
    expect(sibling.length).toBe(0);
    const crossOrg = await asClaims(claims([NS_B1], "human", ORG_B), (tx) =>
      tx`select * from checkpoints`,
    );
    expect(crossOrg.length).toBe(0);
    const anon = await app.begin(async (tx) => tx`select * from checkpoints`);
    expect(anon.length).toBe(0);
  });

  test("handoffs: namespace-scoped reads (own visible, sibling + cross-org + anon denied)", async () => {
    const own = await asClaims(claims([NS_A1]), (tx) => tx`select * from handoffs`);
    expect(own.length).toBe(1);
    expect(own[0].namespace_id).toBe(NS_A1);
    const sibling = await asClaims(claims([NS_A2]), (tx) =>
      tx`select * from handoffs where namespace_id = ${NS_A1}`,
    );
    expect(sibling.length).toBe(0);
    const crossOrg = await asClaims(claims([NS_B1], "human", ORG_B), (tx) =>
      tx`select * from handoffs`,
    );
    expect(crossOrg.length).toBe(0);
    const anon = await app.begin(async (tx) => tx`select * from handoffs`);
    expect(anon.length).toBe(0);
  });

  test("handoffs: cross-namespace write is denied", async () => {
    await expect(
      asClaims(claims([NS_A1]), (tx) =>
        tx`insert into handoffs (id, namespace_id, author_id, state)
           values ('ho_deny_test', ${NS_A2}, ${USER}, '{"x":1}')`,
      ),
    ).rejects.toThrow();
  });

  test("work context: service kind is denied (checkpoints + handoffs)", async () => {
    const cps = await asClaims(claims([NS_A1], "service"), (tx) => tx`select * from checkpoints`);
    const hos = await asClaims(claims([NS_A1], "service"), (tx) => tx`select * from handoffs`);
    expect(cps.length).toBe(0);
    expect(hos.length).toBe(0);
  });

  test("km_event: org-scoped reads (own visible, cross-org + anon denied)", async () => {
    const own = await asClaims(claims([NS_A1]), (tx) => tx`select * from km_event`);
    expect(own.length).toBeGreaterThan(0);
    for (const r of own) expect(r.org_id).toBe(ORG_A);
    const crossOrg = await asClaims(claims([NS_B1], "human", ORG_B), (tx) =>
      tx`select * from km_event`,
    );
    expect(crossOrg.length).toBe(0);
    const anon = await app.begin(async (tx) => tx`select * from km_event`);
    expect(anon.length).toBe(0);
  });

  test("km_event: cross-org write is denied", async () => {
    await expect(
      asClaims(claims([NS_B1], "human", ORG_B), (tx) =>
        tx`insert into km_event (session_id, org_id, kind)
           values ('km_ses_' || repeat('e', 26), ${ORG_A}, 'search')`,
      ),
    ).rejects.toThrow();
  });

  test("km_event: service kind is denied (reads and writes)", async () => {
    const rows = await asClaims(claims([NS_A1], "service"), (tx) => tx`select * from km_event`);
    expect(rows.length).toBe(0);
    await expect(
      asClaims(claims([NS_A1], "service"), (tx) =>
        tx`insert into km_event (session_id, org_id, kind)
           values ('km_ses_' || repeat('e', 26), ${ORG_A}, 'search')`,
      ),
    ).rejects.toThrow();
  });

  // Phase 1a: repeat every case above through the HTTP/MCP path for each
  // km_* tool (search, read, list, graph, append, review, work, insights).
});
