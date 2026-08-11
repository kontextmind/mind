/**
 * GitHub OAuth owner seam e2e (docs/decisions/0001). A mock GitHub server
 * (injectable KM_GITHUB_BASE/API) makes the flow hermetic: no credentials,
 * no network — the same code path production runs against github.com.
 *
 * Flow under test: /authorize (no owner) → /auth/github/start → GitHub
 * authorize redirect (state checked) → /auth/github/callback (state consumed,
 * code exchanged, VERIFIED email only) → owner-session cookie → /authorize
 * succeeds → token exchange → authenticated MCP.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { resolveDbUrl, createDisposableDb, type DisposableDb } from "../../tests/support/db";
import { createFetch } from "../src/app";
import { endDbPools } from "../src/db";
import type { Config } from "../src/config";

const url = resolveDbUrl("github owner auth e2e");
const describeMaybe = url ? describe : describe.skip;

const ISSUER = "http://km-gh.test";
const REDIRECT = "http://localhost:9999/cb";
const GH_EMAIL = "octocat@example.com";

describeMaybe("owner seam: GitHub OAuth", () => {
  let sql: postgres.Sql;
  let disposable: DisposableDb;
  let fetchHandler: (req: Request) => Response | Promise<Response>;
  let ghServer: ReturnType<typeof Bun.serve>;
  let ghBase: string;
  /** Toggle to simulate accounts without verified emails. */
  let verifiedEmail = true;

  const cfgOf = (): Config => ({
    mode: "hosted",
    port: 0,
    demoToken: "unused",
    trustMode: "standard",
    mindPath: null,
    appPassword: "unused",
    githubWebhookSecret: null,
    publicUrl: ISSUER,
    bootstrapEmails: [],
    ownerAuth: "github",
    github: { clientId: "cid-test", clientSecret: "sec-test", base: ghBase, api: ghBase },
    githubApi: ghBase,
    githubApiToken: null,
    authRateLimit: 10000,
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetchHandler(
      new Request(`${ISSUER}${path}`, { headers, redirect: "manual" }),
    );

  const pkce = () => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  };

  const authorizePath = (clientId: string, challenge: string) =>
    `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(ISSUER)}&state=s1`;

  beforeAll(async () => {
    // Mock GitHub: token exchange + verified-email endpoint.
    ghServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/login/oauth/access_token" && req.method === "POST") {
          const body = (await req.json()) as { code?: string; client_id?: string };
          if (body.code !== "mock-code" || body.client_id !== "cid-test") {
            return Response.json({ error: "incorrect_client_credentials" }, { status: 200 });
          }
          return Response.json({ access_token: "ght_mock_token", token_type: "bearer" });
        }
        if (u.pathname === "/user/emails") {
          if (!req.headers.get("authorization")?.includes("ght_mock_token")) {
            return Response.json({ message: "Bad credentials" }, { status: 401 });
          }
          return Response.json([
            { email: "unverified@example.com", primary: false, verified: false },
            { email: GH_EMAIL, primary: true, verified: verifiedEmail },
          ]);
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });
    ghBase = `http://127.0.0.1:${ghServer.port}`;

    disposable = await createDisposableDb(url!, "ghauth");
    process.env.DATABASE_URL = disposable.url;
    await endDbPools();
    sql = postgres(disposable.url, { max: 2, onnotice: () => {} });
    fetchHandler = createFetch(cfgOf());
  });

  afterAll(async () => {
    try {
      ghServer?.stop(true);
    } catch {}
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

  async function registerClient(): Promise<string> {
    const res = await fetchHandler(
      new Request(`${ISSUER}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT] }),
      }),
    );
    return ((await res.json()) as { client_id: string }).client_id;
  }

  test("unauthenticated owner is redirected through GitHub with CSRF state", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const a = await get(authorizePath(clientId, challenge));
    expect(a.status).toBe(302);
    const startLoc = new URL(a.headers.get("location")!, ISSUER);
    expect(startLoc.pathname).toBe("/auth/github/start");
    expect(startLoc.searchParams.get("return")).toContain("/authorize?");

    const s = await get(`${startLoc.pathname}${startLoc.search}`);
    expect(s.status).toBe(302);
    const ghLoc = new URL(s.headers.get("location")!);
    expect(ghLoc.origin).toBe(ghBase); // pointed at the (mock) GitHub
    expect(ghLoc.pathname).toBe("/login/oauth/authorize");
    expect(ghLoc.searchParams.get("client_id")).toBe("cid-test");
    expect(ghLoc.searchParams.get("redirect_uri")).toBe(`${ISSUER}/auth/github/callback`);
    expect(ghLoc.searchParams.get("state")).toMatch(/^gst_/);

    // GitHub redirects the owner back with code + state.
    const state = ghLoc.searchParams.get("state")!;
    const cb = await get(`/auth/github/callback?code=mock-code&state=${state}`);
    expect(cb.status).toBe(302);
    const back = cb.headers.get("location")!;
    expect(back).toContain("/authorize?");
    const cookie = cb.headers.get("set-cookie")!;
    expect(cookie).toContain("km_own=");
    expect(cookie).toContain("HttpOnly");

    // Owner session accepted: /authorize now issues a code.
    const a2 = await get(startLoc.searchParams.get("return")!, { cookie: cookie.split(";")[0] });
    expect(a2.status).toBe(302);
    const done = new URL(a2.headers.get("location")!);
    expect(done.searchParams.get("code")).toBeTruthy();
    expect(done.searchParams.get("state")).toBe("s1");

    // Bootstrapped tenant keyed by the verified GitHub email.
    const users = await sql`select id from users where email = ${GH_EMAIL}`;
    expect(users.length).toBe(1);
  });

  test("owner-session cookie is reusable across authorizations (8h session)", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const a = await get(authorizePath(clientId, challenge));
    const startLoc = new URL(a.headers.get("location")!, ISSUER);
    const s = await get(`${startLoc.pathname}${startLoc.search}`);
    const state = new URL(s.headers.get("location")!).searchParams.get("state")!;
    const cb = await get(`/auth/github/callback?code=mock-code&state=${state}`);
    const cookie = cb.headers.get("set-cookie")!.split(";")[0];
    // Two consecutive authorizations on the same owner session.
    const c1 = await get(startLoc.searchParams.get("return")!, { cookie });
    const c2 = await get(startLoc.searchParams.get("return")!, { cookie });
    expect(c1.status).toBe(302);
    expect(c2.status).toBe(302);
    expect(new URL(c2.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });

  test("CSRF: unknown or consumed state is rejected", async () => {
    const bad = await get("/auth/github/callback?code=mock-code&state=gst_forged");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_state");
    // Consumed-once: use a real state twice.
    const clientId = await registerClient();
    const { challenge } = pkce();
    const a = await get(authorizePath(clientId, challenge));
    const startLoc = new URL(a.headers.get("location")!, ISSUER);
    const s = await get(`${startLoc.pathname}${startLoc.search}`);
    const state = new URL(s.headers.get("location")!).searchParams.get("state")!;
    const first = await get(`/auth/github/callback?code=mock-code&state=${state}`);
    expect(first.status).toBe(302);
    const replay = await get(`/auth/github/callback?code=mock-code&state=${state}`);
    expect(replay.status).toBe(400);
  });

  test("GitHub code exchange failure is a 502, not a login", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const a = await get(authorizePath(clientId, challenge));
    const startLoc = new URL(a.headers.get("location")!, ISSUER);
    const s = await get(`${startLoc.pathname}${startLoc.search}`);
    const state = new URL(s.headers.get("location")!).searchParams.get("state")!;
    const cb = await get(`/auth/github/callback?code=WRONG-code&state=${state}`);
    expect(cb.status).toBe(502);
  });

  test("accounts without a VERIFIED email are denied", async () => {
    verifiedEmail = false;
    try {
      const clientId = await registerClient();
      const { challenge } = pkce();
      const a = await get(authorizePath(clientId, challenge));
      const startLoc = new URL(a.headers.get("location")!, ISSUER);
      const s = await get(`${startLoc.pathname}${startLoc.search}`);
      const state = new URL(s.headers.get("location")!).searchParams.get("state")!;
      const cb = await get(`/auth/github/callback?code=mock-code&state=${state}`);
      expect(cb.status).toBe(403);
      expect((await cb.json()).error).toBe("no_verified_email");
    } finally {
      verifiedEmail = true;
    }
  });
});
