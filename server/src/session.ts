/**
 * KM-Session groundwork (Agent Evidence Trailers v1 — docs/session-spine.md).
 * 1a: issue session IDs, parse trailers. Joining to git evidence lands with
 * the webhook ingestion in 1b/hosted mode.
 */

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
