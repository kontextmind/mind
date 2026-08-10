import postgres from "postgres";

/**
 * Two pools, two trust levels (docs/threat-model.md B2):
 *  - adminDb: superuser — migrations + indexer writes only, never serves queries
 *  - requestDb: km_app (non-superuser) — RLS actually applies; claims bound
 *    per request via SET LOCAL. A superuser request connection would make RLS
 *    decorative; the isolation harness fails loudly if that ever happens.
 */

let admin: postgres.Sql | null = null;
let request: postgres.Sql | null = null;

export function adminDb(): postgres.Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  if (!admin) admin = postgres(url, { max: 5, onnotice: () => {} });
  return admin;
}

export function requestDb(): postgres.Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  if (!request) {
    const password = process.env.KM_APP_PASSWORD ?? "km-demo-local";
    const u = new URL(url);
    u.username = "km_app";
    u.password = password;
    request = postgres(u.toString(), { max: 10, onnotice: () => {} });
  }
  return request;
}

export function hasDb(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Close and forget both pools. `bun test` runs every file in one process, so
 * the lazy singletons above would otherwise stay bound to the first
 * DATABASE_URL they saw — a db-backed suite that swaps in a disposable
 * database would poison the next suite's connections. Call this in teardown
 * before dropping the database.
 */
export async function endDbPools(): Promise<void> {
  try {
    await admin?.end({ timeout: 5 });
  } catch {}
  try {
    await request?.end({ timeout: 5 });
  } catch {}
  admin = null;
  request = null;
}

export interface KmClaims {
  sub: string;
  kind: "human" | "agent";
  org: string;
  namespaces: string[];
  roles: Record<string, "member" | "steward" | "owner">;
}

/** Run a callback with RLS claims bound for this request (SET LOCAL). */
export async function withClaims<T>(
  claims: KmClaims,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const result = await requestDb().begin(async (tx) => {
    await tx.unsafe(`select set_config('km.claims', $1, true)`, [JSON.stringify(claims)]);
    return fn(tx);
  });
  return result as T;
}
