/**
 * kontext login e2e: the device-grant loop with a real spawned CLI —
 * code shown, human approves mid-flight, tokens stored, and a later
 * command authenticates with them (auto-refresh covered too).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { resolveDbUrl, createDisposableDb, type DisposableDb } from "../../tests/support/db";
import { createFetch } from "../../server/src/app";
import { endDbPools } from "../../server/src/db";
import type { Config } from "../../server/src/config";

const url = resolveDbUrl("cli login e2e");
const describeMaybe = url ? describe : describe.skip;

const ISSUER = "http://km-cli.test";
const OWNER = "cli-owner@example.com";
const CLI = join(import.meta.dir, "..", "src", "index.ts");

describeMaybe("kontext login (device grant)", () => {
  let sql: postgres.Sql;
  let disposable: DisposableDb;
  let fetchHandler: (req: Request) => Response | Promise<Response>;
  let server: ReturnType<typeof Bun.serve>;
  let mcpUrl: string;
  let cfgDir: string;

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
    authRateLimit: 10000,
  });

  const spawnCli = (args: string[], env: Record<string, string> = {}) =>
    Bun.spawn(["bun", "run", CLI, ...args], {
      env: { ...process.env, KM_CONFIG_DIR: cfgDir, KM_URL: mcpUrl, KM_TOKEN: "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });

  beforeAll(async () => {
    disposable = await createDisposableDb(url!, "clilogin");
    process.env.DATABASE_URL = disposable.url;
    await endDbPools();
    sql = postgres(disposable.url, { max: 2, onnotice: () => {} });
    fetchHandler = createFetch(cfgOf());
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: fetchHandler });
    mcpUrl = `http://127.0.0.1:${server.port}/mcp`;
    cfgDir = mkdtempSync(join(tmpdir(), "km-cli-cfg-"));
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
    try {
      rmSync(cfgDir, { recursive: true, force: true });
    } catch {}
  }, 30000);

  test(
    "device login: code → human approval → stored tokens → status uses them",
    async () => {
      const child = spawnCli(["login", "--url", mcpUrl]);
      const reader = child.stdout.getReader();
      let out = "";
      const decoder = new TextDecoder();
      // Wait until the CLI prints the user code.
      while (!/Code:\s+([A-Z0-9]{4}-[A-Z0-9]{4})/.test(out)) {
        const { value, done } = await reader.read();
        if (done) break;
        out += decoder.decode(value);
      }
      const code = out.match(/Code:\s+([A-Z0-9]{4}-[A-Z0-9]{4})/)![1];
      reader.releaseLock();

      // The human approves (owner-authenticated) while the CLI polls.
      const approve = await fetchHandler(
        new Request(`${ISSUER}/device/approve?email=${OWNER}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ user_code: code }).toString(),
        }),
      );
      expect(approve.status).toBe(200);

      const exit = await child.exited;
      expect(exit).toBe(0);

      // Tokens + client registration on disk.
      const files = readdirSync(cfgDir);
      const tokensFile = files.find((f) => f.startsWith("tokens-"))!;
      expect(files.some((f) => f.startsWith("client-"))).toBe(true);
      const tokens = JSON.parse(readFileSync(join(cfgDir, tokensFile), "utf8"));
      expect(tokens.access_token).toMatch(/^kmt_/);
      expect(tokens.refresh_token).toMatch(/^kmr_/);

      // A later command authenticates with the stored token (no KM_TOKEN).
      const status = spawnCli(["status"]);
      const statusOut = await new Response(status.stdout).text();
      expect(await status.exited).toBe(0);
      expect(statusOut).toContain("km_ses_");
    },
    45000,
  );

  test(
    "expired stored tokens are refreshed automatically",
    async () => {
      const files = readdirSync(cfgDir);
      const tokensFile = files.find((f) => f.startsWith("tokens-"))!;
      const path = join(cfgDir, tokensFile);
      const stored = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...stored, expires_at: Date.now() - 1000 }));

      const status = spawnCli(["status"]);
      const out = await new Response(status.stdout).text();
      expect(await status.exited).toBe(0);
      expect(out).toContain("km_ses_");
      const refreshed = JSON.parse(readFileSync(path, "utf8"));
      expect(refreshed.expires_at).toBeGreaterThan(Date.now());
      expect(refreshed.access_token).not.toBe(stored.access_token);
    },
    30000,
  );
});
