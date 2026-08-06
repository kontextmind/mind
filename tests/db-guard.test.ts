/**
 * Always-running guard: turns "the db-backed suites silently did nothing" into
 * a red test instead of a green run. See tests/support/db.ts for why.
 */
import { expect, test } from "bun:test";
import postgres from "postgres";
import { resolveDbUrl, skipRequested } from "./support/db";

test("db-backed suites are reachable (not silently skipped)", async () => {
  if (skipRequested()) {
    // Explicit, deliberate opt-out — already warned by resolveDbUrl.
    expect(skipRequested()).toBe(true);
    return;
  }

  const url = resolveDbUrl("db-guard");
  expect(url).toBeTruthy();

  const sql = postgres(url!, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const rows = await sql`select 1 as ok`;
    expect(rows[0].ok).toBe(1);
  } catch (err) {
    throw new Error(
      `Cannot reach the test database, so the isolation harness and MCP e2e ` +
        `suites cannot run. Start it with \`docker compose -f deploy/docker-compose.yml up -d db\`, ` +
        `set TEST_DATABASE_URL, or opt out explicitly with KM_SKIP_DB_TESTS=1. ` +
        `Tried: ${url}. Cause: ${(err as Error).message}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}, 30000);
