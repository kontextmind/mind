/**
 * Consent screen e2e (hosted OAuth): consent is shown once per
 * (client, owner), remembered afterwards; deny reaches the client as
 * access_denied; a pending request can only be resolved by the identity
 * it was authenticated as. autoConsent suites cover the code-flow
 * mechanics; this suite covers the human gate.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { resolveDbUrl, createDisposableDb, type DisposableDb } from "../../tests/support/db";
import { createFetch } from "../src/app";
import { endDbPools } from "../src/db";
import type { Config } from "../src/config";

const url = resolveDbUrl("consent e2e");
const describeMaybe = url ? describe : describe.skip;

const ISSUER = "http://km-consent.test";
const REDIRECT = "http://localhost:9999/cb";
const OWNER = "consent-owner@example.com";

describeMaybe("consent screen (hosted OAuth)", () => {
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
    autoConsent: false,
    authRateLimit: 10000,
  });

  const get = (path: string) =>
    fetchHandler(new Request(`${ISSUER}${path}`, { redirect: "manual" }));

  const postForm = (path: string, fields: Record<string, string>, email = OWNER) =>
    fetchHandler(
      new Request(`${ISSUER}${path}?email=${email}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
        redirect: "manual",
      }),
    );

  const pkce = () => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  };

  const registerClient = async (name: string): Promise<string> => {
    const res = await fetchHandler(
      new Request(`${ISSUER}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT] }),
      }),
    );
    return ((await res.json()) as { client_id: string }).client_id;
  };

  const authorizePath = (clientId: string, challenge: string, state = "cst") =>
    `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(ISSUER)}&state=${state}&email=${OWNER}`;

  beforeAll(async () => {
    disposable = await createDisposableDb(url!, "consent");
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

  test("first authorization shows the consent screen naming client + identity", async () => {
    const clientId = await registerClient("Claude Code");
    const { challenge } = pkce();
    const res = await get(authorizePath(clientId, challenge));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Claude Code");
    expect(html).toContain(OWNER);
    expect(html).toContain("/authorize/approve");
    // No code issued before consent.
    const codes = await sql`select * from oauth_codes`;
    expect(codes.length).toBe(0);
  });

  test("approve: consent recorded, code issued; remembered on the next authorization", async () => {
    const clientId = await registerClient("Codex");
    const { challenge, verifier } = pkce();
    const page = await get(authorizePath(clientId, challenge));
    const html = await page.text();
    const authzId = html.match(/name="authz_id" value="([^"]+)"/)![1];

    const approved = await postForm("/authorize/approve", { authz_id: authzId });
    expect(approved.status).toBe(302);
    const loc = new URL(approved.headers.get("location")!);
    const code = loc.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(loc.searchParams.get("state")).toBe("cst");

    // The recorded consent makes the NEXT authorization direct (no screen).
    const again = await get(authorizePath(clientId, challenge, "cst2"));
    expect(again.status).toBe(302);
    const loc2 = new URL(again.headers.get("location")!);
    expect(loc2.searchParams.get("code")).toBeTruthy();
    expect(loc2.searchParams.get("state")).toBe("cst2");

    // And the whole flow still completes to working tokens.
    const tok = await fetchHandler(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
          resource: ISSUER,
        }).toString(),
      }),
    );
    expect(tok.status).toBe(200);
    const consents = await sql`select * from oauth_consents where client_id = ${clientId}`;
    expect(consents.length).toBe(1);
  });

  test("deny: client receives access_denied; the pending request is consumed", async () => {
    const clientId = await registerClient("Rogue");
    const { challenge } = pkce();
    const page = await get(authorizePath(clientId, challenge, "cst3"));
    const authzId = (await page.text()).match(/name="authz_id" value="([^"]+)"/)![1];
    const denied = await postForm("/authorize/deny", { authz_id: authzId });
    expect(denied.status).toBe(302);
    const loc = new URL(denied.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("cst3");
    // Consumed: replaying the same id is a bad request.
    const replay = await postForm("/authorize/approve", { authz_id: authzId });
    expect(replay.status).toBe(400);
  });

  test("a pending request cannot be approved by a different identity", async () => {
    const clientId = await registerClient("Victim");
    const { challenge } = pkce();
    const page = await get(authorizePath(clientId, challenge));
    const authzId = (await page.text()).match(/name="authz_id" value="([^"]+)"/)![1];
    // Stranger is not in the allowlist — resolveOwner fails outright.
    const stranger = await postForm("/authorize/approve", { authz_id: authzId }, "stranger@example.com");
    expect(stranger.status).toBe(403);
    // The owner's request still works afterwards.
    const approved = await postForm("/authorize/approve", { authz_id: authzId });
    expect(approved.status).toBe(302);
    expect(new URL(approved.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });

  test("unknown or expired authz ids are rejected", async () => {
    const res = await postForm("/authorize/approve", { authz_id: "azr_forged" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
  });
});
