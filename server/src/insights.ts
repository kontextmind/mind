/**
 * Workflow Intelligence — insight detection + the km_insights tool.
 *
 * Insights are derived ONLY from the evidence spine (git_evidence +
 * km_unresolved_trailers, populated from webhooks — docs/webhooks.md).
 * Self-report never produces an insight: principle 1 and 5.
 *
 * Detectors run after each push join (admin lane). Every insight must answer
 * "what decision does this change?" — that question lives in the title:
 *  - loop: intervene / split the task / inspect the churn
 *  - gap:  fix the trailer emitters (commit-msg hook / harness)
 *
 * Dedupe: at most one PENDING insight per (namespace, kind, subject); a
 * redelivered webhook never files a duplicate.
 */
import { randomUUID } from "node:crypto";
import type { JSONValue } from "postgres";
import { adminDb, withClaims, type KmClaims } from "./db";

/** Sessions with ≥ this many unmerged commits in one repo look like a loop. */
export const LOOP_MIN_COMMITS = 6;
/** Coverage needs ≥ this many observed trailers before we judge it. */
export const COVERAGE_MIN_OBSERVED = 5;
/** ≥ this fraction of unresolved trailers = instrumentation gap. */
export const COVERAGE_MAX_UNRESOLVED_RATIO = 0.4;

const PENDING = "pending";

export type InsightKind = "routing" | "loop" | "drift" | "contradiction" | "gap" | "process";

export interface Insight {
  id: string;
  namespace_id: string;
  kind: InsightKind;
  title: string;
  evidence: Record<string, unknown>;
  confidence: number;
  created_at: string;
  expires_at: string | null;
  verdict: string;
  verdict_reason: string | null;
}

function newInsightId(): string {
  return `ins_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/**
 * Resolve the namespace an insight for this repo speaks to: the registered
 * project binding first, else the namespaces of the repo's indexed pages.
 * Returns [] when the repo is not addressable (nothing to surface — an
 * insight with no namespace could not be served under RLS anyway).
 */
export async function namespacesForRepo(repoId: string): Promise<string[]> {
  const sql = adminDb();
  const repo = await sql`
    select default_namespace_id from repos where id = ${repoId}`;
  const linked = repo[0]?.default_namespace_id as string | null | undefined;
  if (linked) return [linked];
  const rows = await sql`
    select distinct namespace_id from pages where repo_id = ${repoId}
    order by namespace_id`;
  return rows.map((r) => r.namespace_id as string);
}

async function pendingExists(namespaceId: string, kind: InsightKind, subject: string): Promise<boolean> {
  const sql = adminDb();
  const rows = await sql`
    select 1 from insights
    where namespace_id = ${namespaceId} and kind = ${kind} and verdict = ${PENDING}
      and evidence ->> 'subject' = ${subject}
    limit 1`;
  return rows.length > 0;
}

/** Deduped file: at most one PENDING insight per (namespace, kind, subject). */
export async function fileInsightIfNew(
  namespaceId: string,
  kind: InsightKind,
  title: string,
  evidence: Record<string, JSONValue>,
  confidence: number,
): Promise<string | null> {
  const subject = String(evidence.subject ?? "");
  if (await pendingExists(namespaceId, kind, subject)) return null;
  const id = newInsightId();
  const sql = adminDb();
  // sql.json(): postgres.js jsonb fragment — a plain string here would be
  // double-encoded (evidence ->> 'subject' sees a JSON string, not an object,
  // and dedupe silently breaks).
  await sql`insert into insights (id, namespace_id, kind, title, evidence, confidence)
    values (${id}, ${namespaceId}, ${kind}, ${title}, ${sql.json(evidence)}, ${confidence})`;
  return id;
}

/**
 * Run all detectors for one repo after a push join. Returns the ids of newly
 * filed insights. Detector errors must never fail the ingestion itself — the
 * evidence rows are the primary artifact.
 */
export async function runDetectors(repoId: string): Promise<string[]> {
  const filed: string[] = [];
  try {
    filed.push(...(await detectLoop(repoId)));
    filed.push(...(await detectCoverageGap(repoId)));
  } catch (err) {
    console.error(`insight detectors failed for ${repoId}: ${(err as Error)?.message ?? err}`);
  }
  return filed;
}

/** A session churning commits without anything merging looks stuck. */
async function detectLoop(repoId: string): Promise<string[]> {
  const sql = adminDb();
  const repo = await sql`select github_full from repos where id = ${repoId}`;
  const name = (repo[0]?.github_full as string | undefined) ?? repoId;
  const rows = await sql`
    select session_id, count(*) as commits
    from git_evidence
    where repo_id = ${repoId} and merged_at is null
    group by session_id
    having count(*) >= ${LOOP_MIN_COMMITS} and count(merged_at) = 0`;
  const out: string[] = [];
  for (const ns of await namespacesForRepo(repoId)) {
    for (const r of rows) {
      const sessionId = r.session_id as string;
      const commits = Number(r.commits);
      const id = await fileInsightIfNew(
        ns,
        "loop",
        `Session ${sessionId.slice(0, 15)}… churned ${commits} unmerged commits in ${name} — intervene or split the task`,
        { subject: `repo:${repoId}:session:${sessionId}`, repo: repoId, session: sessionId, commits },
        0.7,
      );
      if (id) out.push(id);
    }
  }
  return out;
}

/** Too many unresolvable trailers = the emitters are not shipping them. */
async function detectCoverageGap(repoId: string): Promise<string[]> {
  const sql = adminDb();
  const repo = await sql`select github_full from repos where id = ${repoId}`;
  const name = (repo[0]?.github_full as string | undefined) ?? repoId;
  const counts = await sql`
    select
      (select count(*) from git_evidence where repo_id = ${repoId}) as resolved,
      (select count(distinct (sha, trailer)) from km_unresolved_trailers
        where repo_id = ${repoId}) as unresolved`;
  const resolved = Number(counts[0]?.resolved ?? 0);
  const unresolved = Number(counts[0]?.unresolved ?? 0);
  const observed = resolved + unresolved;
  if (observed < COVERAGE_MIN_OBSERVED) return [];
  const ratio = unresolved / observed;
  if (ratio < COVERAGE_MAX_UNRESOLVED_RATIO) return [];
  const pct = Math.round((1 - ratio) * 100);
  const out: string[] = [];
  for (const ns of await namespacesForRepo(repoId)) {
    const id = await fileInsightIfNew(
      ns,
      "gap",
      `Trailer coverage ${pct}% in ${name} — fix the KM-Session emitters`,
      { subject: `repo:${repoId}`, repo: repoId, resolved, unresolved, coverage: pct },
      0.6,
    );
    if (id) out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// km_insights tool (docs/protocol.md) — pull-only; verdicts required to act.
// ---------------------------------------------------------------------------

export interface InsightsArgs {
  action?: "list" | "dismiss";
  namespace?: string;
  kind?: string;
  id?: string;
  verdict?: "accepted" | "dismissed" | "snoozed";
  reason?: string;
}

export async function kmInsights(
  claims: KmClaims,
  args: InsightsArgs,
): Promise<Record<string, unknown>> {
  if (args.action === "dismiss") return dismissInsight(claims, args);
  return listInsights(claims, args);
}

async function listInsights(
  claims: KmClaims,
  args: InsightsArgs,
): Promise<{ insights: Insight[]; count: number }> {
  // Bind before the template: untyped null parameters in `x is null` cannot
  // be typed by PG ("could not determine data type of parameter"); coalesce
  // against the column itself gives the parameter a type and matches all rows.
  const ns: string | null = args.namespace ?? null;
  const kind: string | null = args.kind ?? null;
  return withClaims(claims, async (tx) => {
    const rows = await tx`
      select id, namespace_id, kind, title, evidence, confidence,
             created_at, expires_at, verdict, verdict_reason
      from insights
      where verdict = ${PENDING}
        and namespace_id = coalesce(${ns}, namespace_id)
        and kind = coalesce(${kind}, kind)
        and (expires_at is null or expires_at > now())
      order by confidence desc, created_at desc
      limit 3`;
    const insights = rows.map(toInsight);
    return { insights, count: insights.length };
  });
}

async function dismissInsight(
  claims: KmClaims,
  args: InsightsArgs,
): Promise<Record<string, unknown>> {
  // Bind before the closure: narrowing on args.* does not survive into the
  // withClaims callback, and postgres.js rejects undefined parameters.
  const id = args.id;
  const verdict = args.verdict;
  const reason = args.reason?.trim() || null;
  if (!id) throw new Error("dismiss requires id");
  if (!verdict) throw new Error("dismiss requires a verdict (accepted|dismissed|snoozed)");
  if ((verdict === "dismissed" || verdict === "snoozed") && !reason) {
    throw new Error(`${verdict} requires a reason`);
  }
  return withClaims(claims, async (tx) => {
    const rows = await tx`
      update insights set verdict = ${verdict}, verdict_reason = ${reason}
      where id = ${id} and verdict = ${PENDING}
      returning id, namespace_id, kind, title, evidence, confidence,
                created_at, expires_at, verdict, verdict_reason`;
    if (rows.length === 0) return { error: "not_found", id };
    return { dismissed: toInsight(rows[0]) };
  });
}

function toInsight(r: Record<string, any>): Insight {
  const evidence = typeof r.evidence === "string" ? JSON.parse(r.evidence) : r.evidence;
  return {
    id: r.id,
    namespace_id: r.namespace_id,
    kind: r.kind,
    title: r.title,
    evidence,
    confidence: Number(r.confidence),
    created_at: (r.created_at as Date).toISOString(),
    expires_at: r.expires_at ? (r.expires_at as Date).toISOString() : null,
    verdict: r.verdict,
    verdict_reason: r.verdict_reason ?? null,
  };
}
