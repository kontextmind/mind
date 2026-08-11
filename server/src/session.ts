/**
 * KM-Session groundwork (Agent Evidence Trailers v1 — docs/session-spine.md).
 * Session issuance + beacon handshake live here (shared by the MCP endpoint
 * and the native /v1 API through tool-dispatch). Joining to git evidence
 * happens in webhook.ts.
 */
import { withClaims, type KmClaims } from "./db";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newSessionId(): string {
  const ts = Date.now();
  let time = "";
  let t = ts;
  for (let i = 0; i < 10; i++) {
    time = ULID_ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand += ULID_ALPHABET[Math.floor(Math.random() * 32)];
  }
  return `km_ses_${time}${rand}`.toLowerCase();
}

export const KM_SESSION_RE = /^KM-Session:\s*(km_ses_[0-9a-z]{26})\s*$/gim;

/**
 * Parse KM-Session trailers from a commit message.
 * Returns session IDs in order of appearance; duplicates preserved (callers
 * dedupe). Malformed trailer values are ignored — an unresolvable trailer is
 * recorded as `unresolved` upstream, never silently dropped.
 */
export function parseKmTrailers(commitMessage: string): string[] {
  const out: string[] = [];
  for (const m of commitMessage.matchAll(KM_SESSION_RE)) {
    out.push(m[1]);
  }
  return out;
}

const sessionsByPrincipal = new Map<string, string>();

export async function issueSession(claims: KmClaims): Promise<string> {
  let id = sessionsByPrincipal.get(claims.sub);
  if (id) return id;
  id = newSessionId();
  sessionsByPrincipal.set(claims.sub, id);
  try {
    // Claims-bound write (RLS org policy permits it); the session row carries
    // the claims' org, which is the tenant boundary the webhook join checks.
    // repo binding: first repo registered to the caller's primary namespace —
    // it lets event-driven detectors attribute insights to a namespace.
    const primaryNs = claims.namespaces[0] ?? null;
    await withClaims(claims, async (tx) => {
      const repo = primaryNs
        ? await tx`select id from repos where default_namespace_id = ${primaryNs} limit 1`
        : [];
      const repoId = (repo[0]?.id as string | undefined) ?? null;
      await tx`insert into km_sessions (id, org_id, principal, agent_kind, repo_id)
        values (${id}, ${claims.org}, ${claims.sub},
                ${claims.kind === "agent" ? "other" : null}, ${repoId})
        on conflict (id) do nothing`;
    });
  } catch {
    // session persistence is best-effort; the ID still echoes via km_status
  }
  return id;
}

/** Beacon handshake (docs/protocol.md km_status): skill context for a session. */
export async function recordBeacon(
  claims: KmClaims,
  sessionId: string,
  skill: string,
): Promise<void> {
  try {
    await withClaims(claims, async (tx) => {
      await tx`insert into skill_use (session_id, org_id, skill, provenance, weight)
        values (${sessionId}, ${claims.org}, ${skill}, 'beacon', 1)`;
    });
  } catch {
    // best-effort: km_status still echoes the beacon when persistence fails
  }
}
