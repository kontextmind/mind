/**
 * Work-context plane (docs/protocol.md): checkpoints + claimable handoffs.
 *
 *  - km_work_update  → checkpoint (TTL ~90d, size-capped, secret-scanned)
 *  - km_work_current → tracker read-through (honest: not connected yet) +
 *                      open handoffs + latest checkpoints
 *  - km_handoff_save → bounded state JSON, idempotency key
 *  - km_handoff_load → handoff + claim lease; stale leases are takeable
 *
 * All reads/writes are claims-bound (RLS namespace policies do the tenant
 * enforcement). Gate 2 (docs/secret-gates.md) runs on every stored note and
 * state BEFORE the write — deterministic, never LLM redaction alone.
 */
import { randomUUID } from "node:crypto";
import type { JSONValue } from "postgres";
import { withClaims, type KmClaims } from "./db";
import { scanContent } from "./secrets";

export const TASK_REF_MAX = 512;
export const NOTE_MAX = 8000;
export const STATE_MAX = 32_000;
export const NEXT_STEPS_MAX = 20;
export const STEP_MAX = 500;
/** Claim lease: stale handoffs become takeable after this window. */
export const LEASE_MINUTES = 240;

export interface WorkCtx {
  sessionId: string | null;
}

function denylist(): string[] {
  return (process.env.KM_DENYLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Gate 2 before any work-context write. Findings expose rule ids only. */
function gate(text: string): void {
  const scan = scanContent(text, { denylist: denylist() });
  if (!scan.clean) {
    const rules = [...new Set(scan.findings.map((f) => f.rule))].join(", ");
    throw new Error(`secret_gate: work context rejected (${rules})`);
  }
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function boundCheck(args: { task_ref?: string; note?: string }): void {
  if (args.task_ref && args.task_ref.length > TASK_REF_MAX) {
    throw new Error(`task_ref exceeds ${TASK_REF_MAX} chars`);
  }
  if (args.note !== undefined && args.note.length > NOTE_MAX) {
    throw new Error(`note exceeds ${NOTE_MAX} chars`);
  }
}

// ---------------------------------------------------------------------------
// km_work_update → checkpoint
// ---------------------------------------------------------------------------

export interface WorkUpdateArgs {
  task_ref?: string;
  note: string;
  status?: string;
}

export async function kmWorkUpdate(
  claims: KmClaims,
  args: WorkUpdateArgs,
  ctx: WorkCtx,
): Promise<Record<string, unknown>> {
  if (!args.note || !args.note.trim()) throw new Error("note is required");
  boundCheck(args);
  gate(`${args.task_ref ?? ""}\n${args.note}\n${args.status ?? ""}`);

  const namespaceId = claims.namespaces[0];
  if (!namespaceId) throw new Error("no namespace in claims");
  const id = newId("cp");
  return withClaims(claims, async (tx) => {
    const rows = await tx`
      insert into checkpoints (id, namespace_id, task_ref, author_id, session_id, note, status)
      values (${id}, ${namespaceId}, ${args.task_ref ?? null}, ${claims.sub},
              ${ctx.sessionId}, ${args.note}, ${args.status ?? null})
      returning id, task_ref, status, expires_at, created_at`;
    const r = rows[0];
    return {
      checkpoint: {
        id: r.id as string,
        task_ref: (r.task_ref as string | null) ?? null,
        status: (r.status as string | null) ?? null,
        expires_at: (r.expires_at as Date).toISOString(),
        created_at: (r.created_at as Date).toISOString(),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// km_work_current
// ---------------------------------------------------------------------------

export async function kmWorkCurrent(
  claims: KmClaims,
  args: { namespace?: string },
): Promise<Record<string, unknown>> {
  const ns: string | null = args.namespace ?? null;
  return withClaims(claims, async (tx) => {
    // Latest checkpoint per task_ref (never `limit 1` globally — multiple
    // tasks run concurrently; RLS already scopes to the caller's namespaces).
    const cps = await tx`
      select distinct on (coalesce(task_ref, '')) id, task_ref, author_id, status, note, created_at
      from checkpoints
      where expires_at > now()
        and namespace_id = coalesce(${ns}, namespace_id)
      order by coalesce(task_ref, ''), created_at desc
      limit 5`;
    // Open handoffs: unclaimed, stale-claimed (lease expired), or claimed by
    // the caller. A live lease held by someone else is not "open".
    const handoffs = await tx`
      select id, task_ref, author_id, claimed_by, claimed_at, lease_expires, created_at
      from handoffs
      where namespace_id = coalesce(${ns}, namespace_id)
        and (claimed_by is null or lease_expires < now() or claimed_by = ${claims.sub})
      order by created_at desc
      limit 10`;
    return {
      // Honesty contract: no tracker integration exists yet, so say so.
      // Faking Linear/GitHub state would violate evidence-over-self-report.
      trackers: { connected: false, note: "Linear/GitHub read-through lands with hosted mode" },
      checkpoints: cps.map((r) => ({
        id: r.id as string,
        task_ref: (r.task_ref as string | null) ?? null,
        author_id: r.author_id as string,
        status: (r.status as string | null) ?? null,
        note: r.note as string,
        created_at: (r.created_at as Date).toISOString(),
      })),
      open_handoffs: handoffs.map((r) => ({
        id: r.id as string,
        task_ref: (r.task_ref as string | null) ?? null,
        author_id: r.author_id as string,
        claimed_by: (r.claimed_by as string | null) ?? null,
        lease_expires: r.lease_expires ? (r.lease_expires as Date).toISOString() : null,
        created_at: (r.created_at as Date).toISOString(),
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// km_handoff_save
// ---------------------------------------------------------------------------

export interface HandoffSaveArgs {
  task_ref?: string;
  state: Record<string, JSONValue>;
  next_steps?: string[];
  idempotency_key?: string;
}

export async function kmHandoffSave(
  claims: KmClaims,
  args: HandoffSaveArgs,
  ctx: WorkCtx,
): Promise<Record<string, unknown>> {
  const namespaceId = claims.namespaces[0];
  if (!namespaceId) throw new Error("no namespace in claims");
  if (args.task_ref && args.task_ref.length > TASK_REF_MAX) {
    throw new Error(`task_ref exceeds ${TASK_REF_MAX} chars`);
  }
  const steps = args.next_steps ?? [];
  if (steps.length > NEXT_STEPS_MAX) throw new Error(`next_steps exceeds ${NEXT_STEPS_MAX} items`);
  for (const s of steps) {
    if (typeof s !== "string" || s.length > STEP_MAX) {
      throw new Error(`each next step must be a string ≤ ${STEP_MAX} chars`);
    }
  }
  const stateJson = JSON.stringify(args.state ?? {});
  if (stateJson.length > STATE_MAX) throw new Error(`state exceeds ${STATE_MAX} chars serialized`);
  gate(`${args.task_ref ?? ""}\n${stateJson}\n${steps.join("\n")}`);

  return withClaims(claims, async (tx) => {
    if (args.idempotency_key) {
      const existing = await tx`
        select id, task_ref, created_at from handoffs
        where namespace_id = ${namespaceId} and idempotency_key = ${args.idempotency_key}`;
      if (existing.length > 0) {
        return {
          id: existing[0].id as string,
          task_ref: (existing[0].task_ref as string | null) ?? null,
          created_at: (existing[0].created_at as Date).toISOString(),
          existing: true,
        };
      }
    }
    const id = newId("ho");
    const stateParam = tx.json(args.state ?? {});
    const stepsParam = tx.json(steps);
    const rows = await tx`
      insert into handoffs
        (id, namespace_id, task_ref, author_id, state, next_steps, idempotency_key)
      values (${id}, ${namespaceId}, ${args.task_ref ?? null}, ${claims.sub},
              ${stateParam}, ${stepsParam}, ${args.idempotency_key ?? null})
      returning id, task_ref, created_at`;
    const r = rows[0];
    return {
      id: r.id as string,
      task_ref: (r.task_ref as string | null) ?? null,
      created_at: (r.created_at as Date).toISOString(),
      existing: false,
      session_id: ctx.sessionId,
    };
  });
}

// ---------------------------------------------------------------------------
// km_handoff_load
// ---------------------------------------------------------------------------

export async function kmHandoffLoad(
  claims: KmClaims,
  args: { id: string; claim?: boolean },
): Promise<Record<string, unknown>> {
  return withClaims(claims, async (tx) => {
    const rows = await tx`
      select id, namespace_id, task_ref, author_id, state, next_steps,
             claimed_by, claimed_at, lease_expires, created_at
      from handoffs where id = ${args.id}`;
    if (rows.length === 0) return { error: "not_found", id: args.id };
    const r = rows[0];

    let claim: Record<string, unknown> | null = null;
    if (args.claim) {
      // Atomic takeover: unclaimed, stale lease, or own lease. A live lease
      // held by another principal is respected — departure is trustworthy.
      const upd = await tx`
        update handoffs
        set claimed_by = ${claims.sub}, claimed_at = now(),
            lease_expires = now() + make_interval(mins => ${LEASE_MINUTES})
        where id = ${args.id}
          and (claimed_by is null or claimed_by = ${claims.sub} or lease_expires < now())
        returning claimed_by, claimed_at, lease_expires`;
      if (upd.length > 0) {
        claim = {
          acquired: true,
          claimed_by: claims.sub,
          claimed_at: (upd[0].claimed_at as Date).toISOString(),
          lease_expires: (upd[0].lease_expires as Date).toISOString(),
        };
        r.claimed_by = claims.sub;
        r.claimed_at = upd[0].claimed_at;
        r.lease_expires = upd[0].lease_expires;
      } else {
        claim = {
          acquired: false,
          claimed_by: (r.claimed_by as string | null) ?? null,
          lease_expires: r.lease_expires ? (r.lease_expires as Date).toISOString() : null,
        };
      }
    }

    return {
      handoff: {
        id: r.id as string,
        namespace_id: r.namespace_id as string,
        task_ref: (r.task_ref as string | null) ?? null,
        author_id: r.author_id as string,
        state: typeof r.state === "string" ? JSON.parse(r.state) : r.state,
        next_steps: typeof r.next_steps === "string" ? JSON.parse(r.next_steps) : r.next_steps,
        claimed_by: (r.claimed_by as string | null) ?? null,
        lease_expires: r.lease_expires ? (r.lease_expires as Date).toISOString() : null,
        created_at: (r.created_at as Date).toISOString(),
      },
      claim,
    };
  });
}
