/**
 * Device-authorization grant e2e (RFC 8628, threat-model headless box).
 * Allowlist owner mode: approval needs no browser ceremony, so the suite
 * exercises the full box-side polling contract + the human verdict leg.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import postgres from "postgres";
import { resolveDbUrl, createDisposableDb, type DisposableDb } from "../../tests/support/db";
import { createFetch } from "../src/app";
import { endDbPools } from "../src/db";
import { DEVICE_GRANT_TYPE, DEVICE_INTERVAL_S, DEVICE_TTL_S } from "../src/device-grant";
import type { Config } from "../src/config";

const url = resolveDbUrl("device grant e2e");
const describeMaybe = url ? describe : describe.skip;

const ISSUER = "http://km-device.test";
const OWNER = "dev@example.com";

describeMaybe("device-authorization grant (RFC 8628)", () => {
  let sql: postgres.Sql;
  let disposable: DisposableDb;
  let fetchHandler: (req: Request) => Response | Promise<Response>;

  const cfgOf = (): Config => ({
    mode: "hosted",
    port: 0,
    demoToken: "unused",
    trustMode: "standard",
    mindPath: null,
    appPassword: "unused",
    githubWebhookSecret: null,
    publicUrl: ISSUER,
    bootstrapEmails: [OWNER],
    ownerAuth: "allowlist",
    github: null,
    githubApi: "https://api.github.com",
    githubApiToken: null,
    embeddings: null,
    autoConsent: true,
    authRateLimit: 10000,
  });

  const post = (path: string, fields: Record<string, string>, extra = "") =>
    fetchHandler(
      new Request(`${ISSUER}${path}${extra}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      }),
    );

  const registerClient = async (): Promise<string> => {
    const res = await fetchHandler(
      new Request(`${ISSUER}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://localhost:9999/cb"] }),
      }),
    );
    return ((await res.json()) as { client_id: string }).client_id;
  };

  const startGrant = async (clientId: string) => {
    const res = await post("/device_authorization", { client_id: clientId, resource: ISSUER });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    };
  };

  const poll = (clientId: string, deviceCode: string) =>
    post("/token", {
      grant_type: DEVICE_GRANT_TYPE,
      device_code: deviceCode,
      client_id: clientId,
      resource: ISSUER,
    });

  beforeAll(async () => {
    disposable = await createDisposableDb(url!, "devicegrant");
    process.env.DATABASE_URL = disposable.url;
    await endDbPools();
    sql = postgres(disposable.url, { max: 2, onnotice: () => {} });
    fetchHandler = createFetch(cfgOf());
  });

  afterAll(async () => {
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

  test("metadata advertises the device endpoint and grant type", async () => {
    const meta = await (
      await fetchHandler(new Request(`${ISSUER}/.well-known/oauth-authorization-server`))
    ).json();
    expect(meta.device_authorization_endpoint).toBe(`${ISSUER}/device_authorization`);
    expect(meta.grant_types_supported).toContain(DEVICE_GRANT_TYPE);
  });

  test("device_authorization: shape, unknown client, wrong audience", async () => {
    const clientId = await registerClient();
    const g = await startGrant(clientId);
    expect(g.device_code).toMatch(/^dvc_/);
    expect(g.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(g.verification_uri).toBe(`${ISSUER}/device`);
    expect(g.verification_uri_complete).toContain(g.user_code);
    expect(g.expires_in).toBe(DEVICE_TTL_S);
    expect(g.interval).toBe(DEVICE_INTERVAL_S);

    const unknown = await post("/device_authorization", { client_id: "kmc_no" });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe("invalid_client");

    const wrongAudience = await post("/device_authorization", {
      client_id: clientId,
      resource: "http://other-server",
    });
    expect(wrongAudience.status).toBe(400);
    expect((await wrongAudience.json()).error).toBe("invalid_target");
  });

  test("polling contract: pending → slow_down; approval → tokens, once", async () => {
    const clientId = await registerClient();
    const g = await startGrant(clientId);

    const p1 = await poll(clientId, g.device_code);
    expect(p1.status).toBe(400);
    expect((await p1.json()).error).toBe("authorization_pending");
    const p2 = await poll(clientId, g.device_code); // too fast
    expect((await p2.json()).error).toBe("slow_down");
    const bumped = await sql`select interval_s from oauth_device_grants where device_code = ${g.device_code}`;
    expect(Number(bumped[0].interval_s)).toBe(DEVICE_INTERVAL_S + 5);

    // The human (owner-authenticated) approves the code the box displays.
    const approve = await post("/device/approve", { user_code: g.user_code }, `?email=${OWNER}`);
    expect(approve.status).toBe(200);
    expect((await approve.json()).verdict).toBe("approved");

    const ok = await poll(clientId, g.device_code);
    expect(ok.status).toBe(200);
    const tokens = (await ok.json()) as { access_token: string; refresh_token: string };
    expect(tokens.access_token).toMatch(/^kmt_/);
    expect(tokens.refresh_token).toMatch(/^kmr_/);

    // Consumed once; the tenant was bootstrapped at issuance.
    const again = await poll(clientId, g.device_code);
    expect((await again.json()).error).toBe("invalid_grant");
    const users = await sql`select id from users where email = ${OWNER}`;
    expect(users.length).toBe(1);
  });

  test("denial surfaces as access_denied to the box", async () => {
    const clientId = await registerClient();
    const g = await startGrant(clientId);
    const deny = await post("/device/deny", { user_code: g.user_code }, `?email=${OWNER}`);
    expect((await deny.json()).verdict).toBe("denied");
    const p = await poll(clientId, g.device_code);
    expect((await p.json()).error).toBe("access_denied");
  });

  test("expired grants return expired_token", async () => {
    const clientId = await registerClient();
    const g = await startGrant(clientId);
    await sql`update oauth_device_grants set expires_at = now() - interval '1 minute'
      where device_code = ${g.device_code}`;
    const p = await poll(clientId, g.device_code);
    expect((await p.json()).error).toBe("expired_token");
  });

  test("approval needs an owner and a well-formed code", async () => {
    const anon = await post("/device/approve", { user_code: "ABCD-1234" });
    expect(anon.status).toBe(403);
    const malformed = await post("/device/approve", { user_code: "not-a-code" }, `?email=${OWNER}`);
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toBe("invalid_request");
    const ghost = await post("/device/approve", { user_code: "ZZZZ-9999" }, `?email=${OWNER}`);
    expect(ghost.status).toBe(400);
  });

  test("GET /device serves the approval page to owners only", async () => {
    const page = await fetchHandler(new Request(`${ISSUER}/device?email=${OWNER}`));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Approve a device");
    const anon = await fetchHandler(new Request(`${ISSUER}/device`));
    expect(anon.status).toBe(403);
  });
});
