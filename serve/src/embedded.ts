/**
 * Embedded Postgres tier (phase 2 of the zero-install story): a real
 * Postgres cluster living inside the data directory — no docker, no system
 * service. Ships WITHOUT pgvector, so hybrid search honestly degrades to
 * FTS-only (migration 0001 creates the vector bits conditionally).
 *
 * Binaries arrive via optionalDependencies (@embedded-postgres/<platform>);
 * absent platform → embeddedAvailable() is false → the fallback chain moves
 * on. The cluster auto-stops when the process exits.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export const EMBEDDED_PORT = 5434; // 5432/5433 stay free for dev stacks

export async function embeddedAvailable(): Promise<boolean> {
  try {
    await import("embedded-postgres");
    return true;
  } catch {
    return false;
  }
}

export interface EmbeddedHandle {
  url: string;
  stop: () => Promise<void>;
}

/** Initialise-once, start, and hand back the connection URL. */
export async function ensureEmbeddedPg(
  dataDir: string,
  password: string,
): Promise<EmbeddedHandle> {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const dbDir = join(dataDir, "db");
  const pg = new EmbeddedPostgres({
    databaseDir: dbDir,
    port: EMBEDDED_PORT,
    user: "kontextmind",
    password,
    persistent: true,
  });
  // initialise() runs initdb; the PG_VERSION marker makes it once-per-dir.
  if (!existsSync(join(dbDir, "PG_VERSION"))) {
    await pg.initialise();
  }
  await pg.start();
  try {
    await pg.createDatabase("kontextmind");
  } catch {
    // already exists from a previous run
  }
  return {
    url: `postgres://kontextmind:${password}@localhost:${EMBEDDED_PORT}/kontextmind`,
    stop: () => pg.stop(),
  };
}
