import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db";

const dir = join(import.meta.dir, "../../migrations");

async function main() {
  const sql = db();
  await sql`create table if not exists _migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;
  const done = new Set(
    (await sql`select name from _migrations`).map((r) => r.name as string),
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    if (done.has(f)) continue;
    console.log(`applying ${f}`);
    const body = readFileSync(join(dir, f), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into _migrations (name) values (${f})`;
    });
  }
  console.log("migrations complete");
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
