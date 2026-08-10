/**
 * Webhook ingestion e2e — the server-side join of Agent Evidence Trailers v1
 * (docs/session-spine.md, docs/webhooks.md). Boots the real fetch handler
 * in-process against a disposable database and asserts:
 *  - trailers resolve to git_evidence only within their session's org
 *  - unknown / cross-org trailers land in km_unresolved_trailers (never dropped)
 *  - signature verification is fail-closed
 *
 * Requires TEST_DATABASE_URL (or DATABASE_URL); falls back to the local
 * compose DB. Runs, or fails loudly — see tests/support/db.ts.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { resolveDbUrl, createDisposableDb, type DisposableDb } from "./support/db";
import { createFetch } from "../server/src/app";
import { endDbPools } from "../server/src/db";
import type { Config } from "../server/src/config";

const url = resolveDbUrl("webhook e2e");
const describeMaybe = url ? describe : describe.skip;

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaaaaaa";
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbbbbbb";
const REPO_A = "repo_aaaaaaaaaaaaaaaaaaaaaaa1";
const REPO_B = "repo_bbbbbbbbbbbbbbbbbbbbbbb1";
const SES_A1 = `km_ses_${"a".repeat(26)}`;
const SES_A2 = `km_ses_${"d".repeat(26)}`;
const SES_B1 = `km_ses_${"b".repeat(26)}`;
const GHOST = `km_ses_${"f".repeat(26)}`; // well-formed, never issued

const WH_SECRET = "whsec-e2e-only";

const sha = (c: string) => c.repeat(40);

describeMaybe("webhook ingestion (evidence spine join)", () => {
  let sql: postgres.Sql; // superuser: fixtures + assertions
  let disposable: DisposableDb;
  let fetchHandler: (req: Request) => Response | Promise<Response>;
  let noSecretFetch: (req: Request) => Response | Promise<Response>;

  const cfgOf = (githubWebhookSecret: string | null): Config => ({
    mode: "demo",
    port: 0,
    demoToken: "unused-in-webhook-tests",
    trustMode: "local-demo",
    mindPath: null,
    appPassword: "km-demo-local",
    githubWebhookSecret,
  });

  const post = (
    handler: typeof fetchHandler,
    event: string,
    payload: unknown,
    opts: { secret?: string; sign?: boolean; method?: string } = {},
  ) => {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-github-event": event,
    };
    if (opts.sign !== false) {
      const secret = opts.secret ?? WH_SECRET;
      headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", secret)
        .update(body, "utf8")
        .digest("hex")}`;
    }
    return handler(
      new Request("http://localhost/webhooks/github", {
        method: opts.method ?? "POST",
        headers,
        body: opts.method === "GET" ? undefined : body,
      }),
    );
  };

  const pushPayload = (fullName: string, commits: Array<{ id: string; message: string }>) => ({
    repository: { full_name: fullName },
    commits,
  });

  const evidenceRows = async (repoId: string) =>
    sql`select * from git_evidence where repo_id = ${repoId} order by sha, session_id`;

  beforeAll(async () => {
    disposable = await createDisposableDb(url!, "webhook");
    // The server's db pools are lazy singletons keyed on DATABASE_URL — point
    // them at the disposable DB before the first request touches adminDb().
    process.env.DATABASE_URL = disposable.url;
    // bun test runs every file in one process: forget any pool an earlier
    // suite bound to a different (now-dropped) database.
    await endDbPools();
    sql = postgres(disposable.url, { max: 2, onnotice: () => {} });

    await sql`insert into orgs (id, slug, name) values
      (${ORG_A}, 'org-a', 'Org A'), (${ORG_B}, 'org-b', 'Org B')
      on conflict (id) do nothing`;
    await sql`insert into repos (id, org_id, github_full) values
      (${REPO_A}, ${ORG_A}, 'acme/mind'),
      (${REPO_B}, ${ORG_B}, 'beta/mind')
      on conflict (id) do nothing`;
    await sql`insert into km_sessions (id, org_id, principal) values
      (${SES_A1}, ${ORG_A}, 'agent-1'),
      (${SES_A2}, ${ORG_A}, 'agent-2'),
      (${SES_B1}, ${ORG_B}, 'agent-b')
      on conflict (id) do nothing`;

    fetchHandler = createFetch(cfgOf(WH_SECRET));
    noSecretFetch = createFetch(cfgOf(null));
  });

  afterAll(async () => {
    // Independent steps: a throw in one must not strand the rest. The server
    // pools must close before the drop, and must be FORGOTTEN: bun test runs
    // every file in one process, and a pool left bound to this disposable DB
    // would poison the next suite that boots the server (3D000 database does
    // not exist).
    try {
      await endDbPools();
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

  test("push with a known trailer joins to git_evidence", async () => {
    const res = await post(fetchHandler, "push", pushPayload("acme/mind", [
      { id: sha("1"), message: `feat: thing\n\nKM-Session: ${SES_A1}\n` },
    ]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ evidence_rows: 1, unresolved: 0 });
    const rows = await evidenceRows(REPO_A);
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe(SES_A1);
    expect(rows[0].sha).toBe(sha("1"));
  });

  test("multiple sessions on one commit produce one row each", async () => {
    const res = await post(fetchHandler, "push", pushPayload("acme/mind", [
      { id: sha("2"), message: `pair: work\n\nKM-Session: ${SES_A1}\nKM-Session: ${SES_A2}\n` },
    ]));
    expect(res.status).toBe(200);
    const rows = await sql`select session_id from git_evidence
      where repo_id = ${REPO_A} and sha = ${sha("2")} order by session_id`;
    expect(rows.map((r) => r.session_id)).toEqual([SES_A1, SES_A2]);
  });

  test("duplicate trailers in one message are deduped", async () => {
    await post(fetchHandler, "push", pushPayload("acme/mind", [
      { id: sha("3"), message: `x\n\nKM-Session: ${SES_A1}\nKM-Session: ${SES_A1}\n` },
    ]));
    const rows = await sql`select * from git_evidence
      where repo_id = ${REPO_A} and sha = ${sha("3")}`;
    expect(rows.length).toBe(1);
  });

  test("redelivery is idempotent (no duplicate evidence)", async () => {
    const payload = pushPayload("acme/mind", [
      { id: sha("1"), message: `feat: thing\n\nKM-Session: ${SES_A1}\n` },
    ]);
    const res = await post(fetchHandler, "push", payload);
    expect(res.status).toBe(200);
    const rows = await sql`select * from git_evidence
      where repo_id = ${REPO_A} and sha = ${sha("1")}`;
    expect(rows.length).toBe(1);
  });

  test("unknown trailer is recorded as unresolved, never dropped", async () => {
    const res = await post(fetchHandler, "push", pushPayload("acme/mind", [
      { id: sha("4"), message: `feat: ghost\n\nKM-Session: ${GHOST}\n` },
    ]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ evidence_rows: 0, unresolved: 1 });
    const unresolved = await sql`select * from km_unresolved_trailers
      where repo_id = ${REPO_A} and sha = ${sha("4")}`;
    expect(unresolved.length).toBe(1);
    expect(unresolved[0].trailer).toBe(GHOST);
    const ev = await sql`select * from git_evidence where sha = ${sha("4")}`;
    expect(ev.length).toBe(0);
  });

  test("cross-org trailer claim is denied and recorded (forgery cannot join)", async () => {
    // SES_A1 belongs to org A; a push to org B's repo citing it must not
    // attribute evidence — the session's org must own the repo.
    const res = await post(fetchHandler, "push", pushPayload("beta/mind", [
      { id: sha("5"), message: `feat: steal\n\nKM-Session: ${SES_A1}\n` },
    ]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ evidence_rows: 0, unresolved: 1 });
    const ev = await sql`select * from git_evidence where sha = ${sha("5")}`;
    expect(ev.length).toBe(0);
    const unresolved = await sql`select * from km_unresolved_trailers
      where repo_id = ${REPO_B} and sha = ${sha("5")}`;
    expect(unresolved.length).toBe(1);
  });

  test("commit without trailer is allowed (omission) but attributes nothing", async () => {
    const res = await post(fetchHandler, "push", pushPayload("acme/mind", [
      { id: sha("6"), message: "chore: human commit, no trailer\n" },
    ]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ without_trailer: 1, evidence_rows: 0 });
  });

  test("unregistered repo is acknowledged and ignored", async () => {
    const res = await post(fetchHandler, "push", pushPayload("unknown/repo", [
      { id: sha("7"), message: `x\n\nKM-Session: ${SES_A1}\n` },
    ]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "repo_not_registered" });
  });

  test("check_suite completion updates ci_status and first_green_at", async () => {
    const res = await post(fetchHandler, "check_suite", {
      repository: { full_name: "acme/mind" },
      check_suite: { status: "completed", conclusion: "success", head_sha: sha("1") },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ci_status: "success", updated: 1 });
    const rows = await sql`select ci_status, first_green_at from git_evidence
      where repo_id = ${REPO_A} and sha = ${sha("1")}`;
    expect(rows[0].ci_status).toBe("success");
    expect(rows[0].first_green_at).not.toBeNull();
  });

  test("check_suite before completion is a no-op", async () => {
    const res = await post(fetchHandler, "check_suite", {
      repository: { full_name: "acme/mind" },
      check_suite: { status: "in_progress", head_sha: sha("2") },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "not_completed" });
  });

  test("pull_request attaches pr_number; merge stamps merged_at", async () => {
    // The merge commit itself carries the trailer (it enters via the base-
    // branch push event), so register it first.
    await post(fetchHandler, "push", pushPayload("acme/mind", [
      { id: sha("8"), message: `Merge PR #42\n\nKM-Session: ${SES_A1}\n` },
    ]));
    const opened = await post(fetchHandler, "pull_request", {
      action: "opened",
      repository: { full_name: "acme/mind" },
      pull_request: { number: 42, merged: false, head: { sha: sha("1") } },
    });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ pr_attributed: 1 });

    const closed = await post(fetchHandler, "pull_request", {
      action: "closed",
      repository: { full_name: "acme/mind" },
      pull_request: {
        number: 42,
        merged: true,
        head: { sha: sha("1") },
        merge_commit_sha: sha("8"),
      },
    });
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({ merged: 1 });

    const rows = await sql`select sha, pr_number, merged_at from git_evidence
      where repo_id = ${REPO_A} and sha in (${sha("1")}, ${sha("8")}) order by sha`;
    const head = rows.find((r) => r.sha === sha("1"));
    const merge = rows.find((r) => r.sha === sha("8"));
    expect(head?.pr_number).toBe(42);
    expect(merge?.merged_at).not.toBeNull();
  });

  test("invalid signature is rejected with 401 and writes nothing", async () => {
    const before = await evidenceRows(REPO_A);
    const res = await post(fetchHandler, "push", pushPayload("acme/mind", [
      { id: sha("9"), message: `feat: forged\n\nKM-Session: ${SES_A1}\n` },
    ]), { secret: "attacker-secret" });
    expect(res.status).toBe(401);
    expect((await evidenceRows(REPO_A)).length).toBe(before.length);
  });

  test("missing signature header is rejected with 401", async () => {
    const res = await post(fetchHandler, "push", pushPayload("acme/mind", []), { sign: false });
    expect(res.status).toBe(401);
  });

  test("unconfigured secret fails closed (503, never an open path)", async () => {
    const res = await post(noSecretFetch, "push", pushPayload("acme/mind", []));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "webhook_secret_not_configured" });
  });

  test("GET is 405; ping and unknown events are acknowledged", async () => {
    const get = await post(fetchHandler, "push", {}, { method: "GET" });
    expect(get.status).toBe(405);
    const ping = await post(fetchHandler, "ping", { zen: "hello" });
    expect(ping.status).toBe(200);
    const other = await post(fetchHandler, "issues", { action: "opened" });
    expect(other.status).toBe(200);
    expect(await other.json()).toMatchObject({ ignored: "unsupported_event" });
  });
});
