/**
 * Hosted-mode OAuth 2.1 e2e (docs/threat-model.md B1): discovery, DCR,
 * PKCE code flow with RFC 8707 audience binding, rotating refresh, and the
 * authenticated MCP round-trip — claims constructed server-side, never
 * client-supplied (B2).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveDbUrl, createDisposableDb, type DisposableDb } from "../../tests/support/db";
import { createFetch } from "../src/app";
import { endDbPools } from "../src/db";
import type { Config } from "../src/config";

const url = resolveDbUrl("hosted auth e2e");
const describeMaybe = url ? describe : describe.skip;

const ISSUER = "http://km.test";
const EMAIL = "dev@example.com";
const REDIRECT = "http://localhost:9999/cb";

describeMaybe("hosted auth (OAuth 2.1)", () => {
  let sql: postgres.Sql;
  let disposable: DisposableDb;
  let fetchHandler: (req: Request) => Response | Promise<Response>;
  let server: ReturnType<typeof Bun.serve>;
  let mcpBaseUrl: string;

  const cfgOf = (over: Partial<Config> = {}): Config => ({
    mode: "hosted",
    port: 0,
    demoToken: "unused",
    trustMode: "standard",
    mindPath: null,
    appPassword: "unused",
    githubWebhookSecret: null,
    publicUrl: ISSUER,
    bootstrapEmails: [EMAIL],
    ownerAuth: "allowlist",
    github: null,
    githubApi: "https://api.github.com",
    githubApiToken: null,
    embeddings: null,
    authRateLimit: 10000,
    ...over,
  });

  const req = (
    path: string,
    init: { method?: string; body?: string; type?: string } = {},
  ) =>
    fetchHandler(
      new Request(`${ISSUER}${path}`, {
        method: init.method ?? "GET",
        headers: init.body ? { "content-type": init.type ?? "application/x-www-form-urlencoded" } : {},
        body: init.body,
        redirect: "manual",
      }),
    );

  const pkce = () => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
  };

  const register = async () => {
    const res = await req("/register", {
      method: "POST",
      type: "application/json",
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "e2e" }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { client_id: string };
  };

  const authorizeUrl = (clientId: string, challenge: string, extra = "") =>
    `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(ISSUER)}&state=xyz${extra}`;

  beforeAll(async () => {
    disposable = await createDisposableDb(url!, "hostedauth");
    process.env.DATABASE_URL = disposable.url;
    await endDbPools(); // forget any pool an earlier suite bound elsewhere
    sql = postgres(disposable.url, { max: 2, onnotice: () => {} });
    fetchHandler = createFetch(cfgOf());
    // Real socket for the MCP SDK client (transport fetches, it cannot call
    // the handler function directly).
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: fetchHandler });
    mcpBaseUrl = `http://127.0.0.1:${server.port}/mcp`;
  });

  afterAll(async () => {
    try {
      server?.stop(true);
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

  test("discovery: protected-resource + authorization-server metadata", async () => {
    const pr = await (await req("/.well-known/oauth-protected-resource")).json();
    expect(pr.resource).toBe(ISSUER);
    expect(pr.authorization_servers).toEqual([ISSUER]);
    const as = await (await req("/.well-known/oauth-authorization-server")).json();
    expect(as.issuer).toBe(ISSUER);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
    ]);
    expect(as.registration_endpoint).toBe(`${ISSUER}/register`);
  });

  test("DCR: registration issues a public client; bad redirect rejected", async () => {
    const { client_id } = await register();
    expect(client_id).toMatch(/^kmc_/);
    const bad = await req("/register", {
      method: "POST",
      type: "application/json",
      body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_redirect_uri");
  });

  test("authorize: PKCE S256 is mandatory (OAuth 2.1)", async () => {
    const { client_id } = await register();
    const res = await req(
      `/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&resource=${encodeURIComponent(ISSUER)}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=invalid_request");
  });

  test("authorize: unknown client and unregistered redirect are rejected pre-redirect", async () => {
    const unknown = await req(authorizeUrl("kmc_doesnotexist", "c", ""));
    expect(unknown.status).toBe(400);
    const { client_id } = await register();
    const wrongRedirect = await req(
      `/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent("http://localhost:1/other")}` +
        `&code_challenge=c&code_challenge_method=S256&resource=${encodeURIComponent(ISSUER)}`,
    );
    expect(wrongRedirect.status).toBe(400);
  });

  test("authorize: owner outside the allowlist is denied without redirect leak", async () => {
    const { client_id } = await register();
    const { challenge } = pkce();
    const res = await req(authorizeUrl(client_id, challenge, "&email=stranger@example.com"));
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
  });

  test("authorize: audience binding — wrong resource is rejected", async () => {
    const { client_id } = await register();
    const { challenge } = pkce();
    const res = await req(
      `/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent("http://other-server")}&email=${EMAIL}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=invalid_target");
  });

  test("full flow: code → PKCE exchange → authenticated MCP round-trip", async () => {
    const { client_id } = await register();
    const { verifier, challenge } = pkce();
    const auth = await req(authorizeUrl(client_id, challenge, `&email=${EMAIL}`));
    expect(auth.status).toBe(302);
    const loc = new URL(auth.headers.get("location")!);
    expect(loc.searchParams.get("state")).toBe("xyz");
    const code = loc.searchParams.get("code");
    expect(code).toBeTruthy();

    // First login bootstrapped the tenant: user + org + owner membership + namespace.
    const users = await sql`select id from users where email = ${EMAIL}`;
    expect(users.length).toBe(1);
    const orgs = await sql`select o.id from orgs o join memberships m on m.org_id = o.id where m.user_id = ${users[0].id}`;
    expect(orgs.length).toBe(1);

    const tok = await req("/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: REDIRECT,
        client_id,
        code_verifier: verifier,
        resource: ISSUER,
      }).toString(),
    });
    expect(tok.status).toBe(200);
    const tokens = (await tok.json()) as Record<string, unknown>;
    expect(String(tokens.access_token)).toMatch(/^kmt_/);
    expect(String(tokens.refresh_token)).toMatch(/^kmr_/);
    expect(tokens.expires_in).toBe(3600);

    // The access token authenticates /mcp — claims constructed server-side.
    const transport = new StreamableHTTPClientTransport(new URL(mcpBaseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    });
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(transport);
    const res = JSON.parse(
      ((await client.callTool({ name: "km_status", arguments: {} })).content as Array<{ text?: string }>)
        .map((c) => c.text ?? "")
        .join(""),
    );
    expect(res.session_id).toMatch(/^km_ses_[0-9a-z]{26}$/);
    expect(res.trust_mode).toBe("standard");
    const sessions = await sql`select principal from km_sessions where id = ${res.session_id}`;
    expect(sessions[0].principal).toBe(users[0].id); // bound to the token's user
    await client.close();

    // Code is one-time.
    const replay = await req("/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: REDIRECT,
        client_id,
        code_verifier: verifier,
        resource: ISSUER,
      }).toString(),
    });
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("invalid_grant");

    // Refresh rotates: new pair works, old refresh is dead.
    const refresh = async (rt: string) =>
      req("/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: rt,
          client_id,
          resource: ISSUER,
        }).toString(),
      });
    const r1 = await refresh(String(tokens.refresh_token));
    expect(r1.status).toBe(200);
    const t2 = (await r1.json()) as { refresh_token: string };
    const replayRefresh = await refresh(String(tokens.refresh_token));
    expect(replayRefresh.status).toBe(400);
    expect(t2.refresh_token).not.toBe(tokens.refresh_token);
  });

  test("token: wrong PKCE verifier and wrong audience are rejected", async () => {
    const { client_id } = await register();
    const { verifier, challenge } = pkce();
    const auth = await req(authorizeUrl(client_id, challenge, `&email=${EMAIL}`));
    const code = new URL(auth.headers.get("location")!).searchParams.get("code")!;
    const badVerifier = await req("/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id,
        code_verifier: "wrong-verifier-value-wrong-verifier-value",
        resource: ISSUER,
      }).toString(),
    });
    expect(badVerifier.status).toBe(400);
    expect((await badVerifier.json()).error).toBe("invalid_grant");

    // Consumed above — new code for the audience test.
    const auth2 = await req(authorizeUrl(client_id, challenge, `&email=${EMAIL}`));
    const code2 = new URL(auth2.headers.get("location")!).searchParams.get("code")!;
    const badAudience = await req("/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code2,
        redirect_uri: REDIRECT,
        client_id,
        code_verifier: verifier,
        resource: "http://other-server",
      }).toString(),
    });
    expect(badAudience.status).toBe(400);
    expect((await badAudience.json()).error).toBe("invalid_target");
  });

  test("/mcp: missing or bogus token → 401 with RFC 9728 WWW-Authenticate", async () => {
    const missing = await req("/mcp", { method: "POST", body: "{}" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("oauth-protected-resource");
    const bogus = await fetchHandler(
      new Request(`${ISSUER}/mcp`, {
        method: "POST",
        headers: { Authorization: "Bearer kmt_bogus", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(bogus.status).toBe(401);
    expect((await bogus.json()).error).toBe("invalid_token");
  });

  test("rate limiting: auth endpoints 429 past the per-IP budget", async () => {
    const limited = createFetch(cfgOf({ authRateLimit: 3 }));
    let last: Response | null = null;
    for (let i = 0; i < 6; i++) {
      last = await limited(
        new Request(`${ISSUER}/token`, { method: "POST", body: "grant_type=x" }),
      );
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get("retry-after")).toBe("60");
  });

  test("demo mode keeps OAuth discovery dark (hosted-only surface)", async () => {
    const demo = createFetch(cfgOf({ mode: "demo" }));
    const res = await demo(new Request(`${ISSUER}/.well-known/oauth-protected-resource`));
    expect(res.status).toBe(501);
  });
});
