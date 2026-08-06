/**
 * Shared DB resolution for the db-backed suites.
 *
 * History: both suites used `const d = env.X ?? env.Y; const describeMaybe = d
 * ? describe : describe.skip`. With no env set, `bun test` reported
 * "0 pass, 18 skip, 0 fail" and exited 0 — green having tested nothing. A
 * write-path bug that corrupted every review_items row shipped underneath that
 * green. The isolation harness is the cross-tenant deny gate (ci.yml) and is
 * branch-protection required, so a dropped env var or a failed service
 * container would let the gate pass vacuously.
 *
 * Now: absent env falls back to the URL the shipped docker-compose serves, so
 * a suite either runs, or fails loudly when the DB is unreachable. Skipping is
 * possible only by explicitly setting KM_SKIP_DB_TESTS=1, and says so.
 */

import postgres from "postgres";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Matches deploy/docker-compose.yml — the DB a contributor already has up. */
export const DEFAULT_LOCAL_DB =
  "postgres://kontextmind:kontextmind-dev-only@localhost:5432/kontextmind";

const REPO_ROOT = join(import.meta.dir, "..", "..");

export function skipRequested(): boolean {
  return process.env.KM_SKIP_DB_TESTS === "1";
}

/**
 * The DB URL a suite should use, or null when the operator explicitly opted
 * out. Never returns null merely because the environment is unconfigured.
 *
 * Also pins process.env.DATABASE_URL to the resolved URL: mcp.test.ts boots the
 * real server in-process, and loadConfig()/db.ts read that variable directly.
 * Without this the tests would talk to one DB while the server under test
 * booted degraded ("DATABASE_URL not set; MCP unavailable") — or worse, ran
 * against a different database than the assertions inspect.
 */
export function resolveDbUrl(suite: string): string | null {
  const explicit = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!explicit && skipRequested()) {
    console.warn(
      `\n  !! ${suite}: SKIPPED via KM_SKIP_DB_TESTS=1 — db-backed coverage did NOT run.\n`,
    );
    return null;
  }
  const url = explicit ?? DEFAULT_LOCAL_DB;
  process.env.DATABASE_URL = url;
  return url;
}

function urlForDatabase(base: string, name: string): string {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
}

export interface DisposableDb {
  url: string;
  name: string;
  drop(): Promise<void>;
}

/**
 * Create a throwaway database for one suite run: migrations applied, km_app
 * granted, dropped in afterAll.
 *
 * Why: the suites used to share one database, so every run left review_items
 * and tombstoned pages behind (72 rows before the first manual GC), and a
 * pending item from one test could be picked up by another — that actually
 * happened, with a deliberately-unpromotable fixture poisoning a later promote
 * test. A fresh database per run makes both impossible and needs no cleanup
 * code in the tests themselves.
 *
 * `km_app` is a cluster-level role, so it is created once and reused; the
 * per-database grants are re-applied against each new database.
 */
export async function createDisposableDb(baseUrl: string, label: string): Promise<DisposableDb> {
  const name = `km_test_${label}_${process.pid}_${Date.now().toString(36)}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 60);
  const maintUrl = urlForDatabase(baseUrl, "postgres");

  const maint = postgres(maintUrl, { max: 1, onnotice: () => {} });
  try {
    // CREATE DATABASE cannot run inside a transaction — hence unsafe(), not a
    // tagged template inside begin().
    await maint.unsafe(`create database "${name}"`);
    await maint.unsafe(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'km_app') then
        create role km_app login password 'km-demo-local';
      end if;
    end $$`);
  } finally {
    await maint.end({ timeout: 5 });
  }

  const url = urlForDatabase(baseUrl, name);
  const db = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const dir = join(REPO_ROOT, "migrations");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      await db.unsafe(readFileSync(join(dir, f), "utf8"));
    }
    await db.unsafe("grant usage on schema public to km_app");
    await db.unsafe("grant select, insert, update, delete on all tables in schema public to km_app");
    await db.unsafe("grant usage on all sequences in schema public to km_app");
  } finally {
    await db.end({ timeout: 5 });
  }

  return {
    url,
    name,
    async drop() {
      const m = postgres(maintUrl, { max: 1, onnotice: () => {} });
      try {
        // FORCE: the server under test holds a pooled connection that outlives
        // the suite, and a plain DROP would block on it.
        await m.unsafe(`drop database if exists "${name}" with (force)`);
      } finally {
        await m.end({ timeout: 5 });
      }
    },
  };
}
