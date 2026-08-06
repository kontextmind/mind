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

/** Matches deploy/docker-compose.yml — the DB a contributor already has up. */
export const DEFAULT_LOCAL_DB =
  "postgres://kontextmind:kontextmind-dev-only@localhost:5432/kontextmind";

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
