/**
 * km_event — the session activity stream (docs/session-spine.md).
 *
 * CONTRACT (from the schema comment, binding): payloads are LOW-CARDINALITY —
 * tool + args-hash + derived counters ONLY. Raw args (queries, notes, state)
 * are never stored. An event row must be safe to show to anyone in the org.
 *
 * Recording is claims-bound (org RLS policy) and best-effort: an event write
 * must never fail the tool call it observes.
 */
import { createHash } from "node:crypto";
import { adminDb, withClaims, type KmClaims } from "./db";
import { fileInsightIfNew, namespacesForRepo } from "./insights";

export type EventKind =
  | "search"
  | "read"
  | "append"
  | "review"
  | "chat"
  | "checkpoint"
  | "handoff_save"
  | "handoff_claim";

/** Stable 16-hex digest of the args — joinable, but never reversible. */
export function argsHash(args: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16);
}

/**
 * Record one event. `extra` must stay low-cardinality (counts, enums,
 * booleans) — see the module contract. Never pass user content through it.
 */
export async function recordEvent(
  claims: KmClaims,
  sessionId: string,
  kind: EventKind,
  extra: Record<string, string | number | boolean> = {},
): Promise<void> {
  try {
    await withClaims(claims, async (tx) => {
      const payload = tx.json({ kind, ...extra });
      await tx`insert into km_event (session_id, org_id, kind, payload)
        values (${sessionId}, ${claims.org}, ${kind}, ${payload})`;
    });
  } catch (err) {
    // Observation must never break the observed path.
    console.error(`km_event record failed (${kind}): ${(err as Error)?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// Event-driven detection — runs on km_status (the session heartbeat), because
// insights are pull-only: no push, no cron surprises.
// ---------------------------------------------------------------------------

/** ≥ this many zero-hit searches with no successful search = gap candidate. */
export const EMPTY_SEARCH_MIN = 3;

/**
 * Knowledge-gap detector: a session whose CURRENT streak of searches all
 * came back empty is pointing at a hole in the mind (an earlier success
 * resets the streak — a past hit means the mind was findable then). Fires
 * on streaks ≥ EMPTY_SEARCH_MIN. Attributed via session → repo → namespace
 * (migration 0007); unaddressable sessions skip.
 */
export async function runEventDetectors(orgId: string): Promise<string[]> {
  try {
    return await detectEmptySearchChurn(orgId);
  } catch (err) {
    console.error(`event detectors failed: ${(err as Error)?.message ?? err}`);
    return [];
  }
}

async function detectEmptySearchChurn(orgId: string): Promise<string[]> {
  const sql = adminDb();
  // Searches since the session's last successful search = the current empty
  // streak. e.id is monotonic per insertion order.
  const rows = await sql`
    select e.session_id, count(*) as searches
    from km_event e
    join km_sessions s on s.id = e.session_id
    where e.org_id = ${orgId}
      and e.kind = 'search'
      and coalesce((e.payload ->> 'hits')::int, 0) = 0
      and e.id > coalesce(
        (select max(e2.id) from km_event e2
         where e2.session_id = e.session_id and e2.kind = 'search'
           and coalesce((e2.payload ->> 'hits')::int, 0) > 0),
        0)
    group by e.session_id
    having count(*) >= ${EMPTY_SEARCH_MIN}`;

  const out: string[] = [];
  for (const r of rows) {
    const sessionId = r.session_id as string;
    const searches = Number(r.searches);
    // Session → repo → namespace attribution. Sessions without a bound repo
    // (or repos without an addressable namespace) cannot host an insight.
    const ses = await sql`select repo_id from km_sessions where id = ${sessionId}`;
    const repoId = ses[0]?.repo_id as string | null | undefined;
    if (!repoId) continue;
    for (const ns of await namespacesForRepo(repoId)) {
      const id = await fileInsightIfNew(
        ns,
        "gap",
        `Session ${sessionId.slice(0, 15)}…: ${searches} empty searches — knowledge gap candidate`,
        { subject: `repo:${repoId}:session:${sessionId}:empty-searches`, session: sessionId, searches },
        0.6,
      );
      if (id) out.push(id);
    }
  }
  return out;
}
