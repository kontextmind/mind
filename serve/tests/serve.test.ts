/**
 * kontextmind serve — data-dir lifecycle + full boot e2e. The server boots
 * against a disposable DB through the SAME code path npx/bunx users hit:
 * startServe → migrations → handler. The node bridge is proven with a real
 * HTTP round-trip (that's the npx runtime path).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { resolveDbUrl, type DisposableDb } from "../../tests/support/db";
import { endDbPools } from "../../server/src/db";
import {
  defaultDataDir,
  ensureMindRepo,
  ensureServerJson,
  pickDbSource,
  startServe,
  type StartedServe,
} from "../src/serve";
import { nodeServe } from "../src/node-serve";

const url = resolveDbUrl("kontextmind serve");
const describeMaybe = url ? describe : describe.skip;

describeMaybe("serve primitives (no db needed)", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "km-serve-"));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("defaultDataDir honors KONTEXTMIND_HOME", () => {
    const prev = process.env.KONTEXTMIND_HOME;
    process.env.KONTEXTMIND_HOME = "/tmp/km-home-test";
    try {
      expect(defaultDataDir()).toBe("/tmp/km-home-test");
    } finally {
      if (prev === undefined) delete process.env.KONTEXTMIND_HOME;
      else process.env.KONTEXTMIND_HOME = prev;
    }
  });

  test("ensureMindRepo bootstraps a git mind once, then leaves it alone", () => {
    const mind = join(tmp, "mind");
    expect(ensureMindRepo(mind)).toBe("created");
    expect(existsSync(join(mind, "purpose.md"))).toBe(true);
    expect(existsSync(join(mind, "decisions"))).toBe(true);
    expect(existsSync(join(mind, ".git"))).toBe(true);
    // Idempotent: a second run must not touch the repo.
    expect(ensureMindRepo(mind)).toBe("existing");
  });

  test("ensureServerJson generates once and reuses forever", () => {
    const p = join(tmp, "server.json");
    const first = ensureServerJson(p);
    expect(first.created).toBe(true);
    expect(first.state.token).toMatch(/^km_tok_[0-9a-f]{32}$/);
    const second = ensureServerJson(p);
    expect(second.created).toBe(false);
    expect(second.state.token).toBe(first.state.token); // stable identity
  });

  test("pickDbSource precedence: env > docker > local > none", () => {
    expect(pickDbSource({ envUrl: "postgres://x/y" })?.source).toBe("env");
    expect(pickDbSource({ envUrl: "postgres://x/y", docker: true })?.source).toBe("env");
    expect(pickDbSource({ docker: true, localPgReachable: true })?.source).toBe("docker");
    expect(pickDbSource({ localPgReachable: true })?.source).toBe("local-postgres");
    expect(pickDbSource({ localPgReachable: true, embeddedAvailable: true })?.source).toBe("local-postgres");
    expect(pickDbSource({ embeddedAvailable: true })?.source).toBe("embedded");
    expect(pickDbSource({})).toBeNull();
  });
});

describeMaybe("serve boot e2e (disposable db)", () => {
  let disposable: DisposableDb;
  let sql: postgres.Sql;
  let dataDir: string;
  let started: StartedServe;

  /**
   * BARE database — no pre-applied migrations. serve must run the migration
   * ladder itself (and record it in _migrations); the shared disposable
   * fixture applies SQL without recording state, which serve would replay.
   */
  async function createBareDb(label: string): Promise<DisposableDb> {
    const name = `km_test_${label}_${process.pid}_${Date.now().toString(36)}`
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 60);
    const u = new URL(url!);
    const maintUrl = (() => {
      const m = new URL(url!);
      m.pathname = "/postgres";
      return m.toString();
    })();
    const maint = postgres(maintUrl, { max: 1, onnotice: () => {} });
    try {
      await maint.unsafe(`create database "${name}"`);
      await maint.unsafe(`do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'km_app') then
          create role km_app login password 'km-demo-local';
        end if;
      end $$`);
    } finally {
      await maint.end({ timeout: 5 });
    }
    u.pathname = `/${name}`;
    const db = postgres(u.toString(), { max: 1, onnotice: () => {} });
    try {
      await db.unsafe("grant usage on schema public to km_app");
    } finally {
      await db.end({ timeout: 5 });
    }
    return {
      url: u.toString(),
      name,
      async drop() {
        const m = postgres(maintUrl, { max: 1, onnotice: () => {} });
        try {
          await m.unsafe(`drop database if exists "${name}" with (force)`);
        } finally {
          await m.end({ timeout: 5 });
        }
      },
    };
  }

  beforeAll(async () => {
    disposable = await createBareDb("serve");
    dataDir = mkdtempSync(join(tmpdir(), "km-serve-data-"));
    await endDbPools();
    started = await startServe({ dataDir, databaseUrl: disposable.url });
    sql = postgres(disposable.url, { max: 1, onnotice: () => {} });
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
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }, 30000);

  test("data dir contains mind + server.json; migrations applied", async () => {
    expect(started.info.dbSource).toBe("env");
    expect(existsSync(join(dataDir, "mind", "purpose.md"))).toBe(true);
    expect(existsSync(join(dataDir, "server.json"))).toBe(true);
    const migs = await sql`select count(*)::int as n from _migrations`;
    expect(migs[0].n).toBeGreaterThanOrEqual(12);
  });

  test("healthz reports the real version", async () => {
    const res = await started.handler(new Request("http://localhost/healthz"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string; mode: string };
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.mode).toBe("demo");
  });

  test("generated token authenticates /mcp (full loop)", async () => {
    const token = JSON.parse(readFileSync(join(dataDir, "server.json"), "utf8")).token;
    expect(token).toBe(started.info.token);
    const res = await started.handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "serve-test", version: "0.0.0" },
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("kontextmind");
    // Wrong token still bounces.
    const bad = await started.handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
        body: "{}",
      }),
    );
    expect(bad.status).toBe(401);
  });

  test("node bridge serves real HTTP (the npx path)", async () => {
    const s = await nodeServe(started.handler, 0, "127.0.0.1");
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/healthz`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    } finally {
      s.close();
    }
  });
});
