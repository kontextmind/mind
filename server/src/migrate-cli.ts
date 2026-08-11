/** CLI entry: apply migrations to $DATABASE_URL (bun run db:migrate). */
import { join } from "node:path";
import { adminDb } from "./db";
import { readMigrationFiles, runMigrations } from "./migrate";

const sql = adminDb();
runMigrations(sql, readMigrationFiles(join(import.meta.dir, "../../migrations")))
  .then(() => sql.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
