import { join } from "node:path";
import type postgres from "postgres";

import { readdirSync, readFileSync } from "node:fs";

export interface MigrationFile {
  name: string;
  body: string;
}

/** Read the migrations directory (server checkout layout). */
export function readMigrationFiles(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, body: readFileSync(join(dir, name), "utf8") }));
}

/**
 * Idempotent, replayable migration runner (state in _migrations). Exported
 * so `bun run db:migrate` (migrate-cli.ts) and `kontextmind serve` share one
 * implementation. This module must stay side-effect-free: it is bundled into
 * the serve binary, where an import-time side effect would run migrations
 * against whatever DATABASE_URL happens to be set.
 */
export async function runMigrations(
  sql: postgres.Sql,
  files: MigrationFile[],
): Promise<number> {
  await sql`create table if not exists _migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;
  const done = new Set(
    (await sql`select name from _migrations`).map((r) => r.name as string),
  );
  let applied = 0;
  for (const f of files) {
    if (done.has(f.name)) continue;
    console.log(`applying ${f.name}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(f.body);
      await tx`insert into _migrations (name) values (${f.name})`;
    });
    applied++;
  }
  if (applied > 0) console.log(`migrations complete (${applied} applied)`);
  return applied;
}
