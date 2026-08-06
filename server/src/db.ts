import postgres from "postgres";

let sql: postgres.Sql | null = null;

export function db(): postgres.Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  if (!sql) {
    sql = postgres(url, { max: 10, onnotice: () => {} });
  }
  return sql;
}

export function hasDb(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export interface KmClaims {
  sub: string;
  kind: "human" | "agent" | "service";
  org: string;
  namespaces: string[];
  roles: Record<string, "member" | "steward" | "owner">;
}

/**
 * Run a callback inside a transaction with RLS claims bound for the request.
 * Claims are set via SET LOCAL — they never leak across connections.
 * The service kind is rejected here: the indexer uses a separate role.
 */
export async function withClaims<T>(
  claims: KmClaims,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  if (claims.kind === "service") {
    throw new Error("service claims cannot serve requests");
  }
  const client = db();
  return client.begin(async (tx) => {
    await tx.unsafe(`select set_config('km.claims', $1, true)`, [
      JSON.stringify(claims),
    ]);
    return fn(tx);
  });
}
