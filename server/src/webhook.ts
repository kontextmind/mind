/**
 * GitHub webhook ingestion — the server-side join of Agent Evidence Trailers
 * v1 (docs/session-spine.md, docs/webhooks.md).
 *
 * `git_evidence` is populated ONLY here — never from agent self-report.
 *
 * Security posture:
 *  - HMAC-SHA256 (X-Hub-Signature-256) against KM_GITHUB_WEBHOOK_SECRET;
 *    fail-closed when the secret is unset (503, never an open ingestion path).
 *  - Tenant boundary is enforced at join time: a trailer resolves only when
 *    the session exists AND its org owns the repo. Everything else — unknown
 *    IDs, cross-org claims (forgery attempts) — lands in
 *    km_unresolved_trailers. Agents can omit trailers but cannot fake them.
 *  - Writes go through the superuser connection (same lane as the indexer):
 *    the ingestion service has no user claims, and git_evidence/km_sessions
 *    carry no permissive write policies for km_app by design.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { adminDb, hasDb } from "./db";
import type { Config } from "./config";
import { parseKmTrailers } from "./session";

/** GitHub event payloads are small; this is a wall against abuse, not tuning. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Constant-time HMAC-SHA256 check of the GitHub signature header.
 * Header form: `sha256=<hex>` (anything else is rejected).
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string | null,
): boolean {
  if (!header) return false;
  const m = /^sha256=(.+)$/.exec(header.trim());
  if (!m) return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(body, "utf8").digest("hex"),
    "utf8",
  );
  const got = Buffer.from(m[1].trim().toLowerCase(), "utf8");
  return expected.length === got.length && timingSafeEqual(expected, got);
}

interface RepoRow {
  id: string;
  org_id: string;
}

async function findRepo(githubFull: string): Promise<RepoRow | null> {
  const sql = adminDb();
  const rows = await sql`
    select id, org_id from repos where github_full = ${githubFull} limit 1`;
  return (rows[0] as RepoRow | undefined) ?? null;
}

/**
 * Resolve one trailer against a pushed commit.
 * Returns true when a git_evidence row was (idempotently) created.
 * Unknown session IDs and cross-org claims are recorded as unresolved.
 */
async function joinTrailer(
  repo: RepoRow,
  sha: string,
  trailer: string,
): Promise<boolean> {
  const sql = adminDb();
  const rows = await sql`select id, org_id from km_sessions where id = ${trailer}`;
  const session = rows[0] as { id: string; org_id: string } | undefined;
  if (!session || session.org_id !== repo.org_id) {
    await sql`insert into km_unresolved_trailers (repo_id, sha, trailer)
      values (${repo.id}, ${sha}, ${trailer})`;
    return false;
  }
  await sql`insert into git_evidence (session_id, repo_id, sha)
    values (${session.id}, ${repo.id}, ${sha})
    on conflict (repo_id, sha, session_id) do nothing`;
  return true;
}

type Payload = Record<string, any>;

async function handlePush(payload: Payload): Promise<Record<string, unknown>> {
  const fullName: string | undefined = payload?.repository?.full_name;
  const repo = fullName ? await findRepo(fullName) : null;
  if (!repo) {
    // 200 (not 4xx): GitHub retries non-2xx, and an unregistered repo is a
    // stable condition — retrying would never succeed.
    return { ok: true, ignored: "repo_not_registered", repository: fullName ?? null };
  }
  const commits: Payload[] = Array.isArray(payload?.commits) ? payload.commits : [];
  let evidence = 0;
  let unresolved = 0;
  let withoutTrailer = 0;
  for (const c of commits) {
    const sha = String(c?.id ?? "");
    if (!SHA_RE.test(sha)) continue;
    const trailers = [...new Set(parseKmTrailers(String(c?.message ?? "")))];
    if (trailers.length === 0) {
      // Omission is allowed by the spec; it just cannot attribute evidence.
      withoutTrailer++;
      continue;
    }
    for (const t of trailers) {
      if (await joinTrailer(repo, sha, t)) evidence++;
      else unresolved++;
    }
  }
  return {
    ok: true,
    repository: fullName,
    commits: commits.length,
    evidence_rows: evidence,
    unresolved,
    without_trailer: withoutTrailer,
  };
}

async function handleCheckSuite(payload: Payload): Promise<Record<string, unknown>> {
  const fullName: string | undefined = payload?.repository?.full_name;
  const repo = fullName ? await findRepo(fullName) : null;
  if (!repo) return { ok: true, ignored: "repo_not_registered", repository: fullName ?? null };
  const cs: Payload | undefined = payload?.check_suite;
  const sha = String(cs?.head_sha ?? "");
  if (!cs || cs.status !== "completed" || !cs.conclusion || !SHA_RE.test(sha)) {
    return { ok: true, ignored: "not_completed", repository: fullName };
  }
  const conclusion = String(cs.conclusion);
  const sql = adminDb();
  const res = await sql`
    update git_evidence set
      ci_status = ${conclusion},
      first_green_at = case
        when ${conclusion} = 'success' and first_green_at is null then now()
        else first_green_at
      end
    where repo_id = ${repo.id} and sha = ${sha}`;
  return { ok: true, repository: fullName, sha, ci_status: conclusion, updated: res.count };
}

async function handlePullRequest(payload: Payload): Promise<Record<string, unknown>> {
  const fullName: string | undefined = payload?.repository?.full_name;
  const repo = fullName ? await findRepo(fullName) : null;
  if (!repo) return { ok: true, ignored: "repo_not_registered", repository: fullName ?? null };
  const pr: Payload | undefined = payload?.pull_request;
  if (!pr) return { ok: true, ignored: "no_pull_request", repository: fullName };

  const sql = adminDb();
  let prAttributed = 0;
  const headSha = String(pr?.head?.sha ?? "");
  if (pr.number != null && SHA_RE.test(headSha)) {
    // Push events for the PR branch already created the evidence rows; this
    // attaches the PR number to them.
    const res = await sql`
      update git_evidence set pr_number = ${Number(pr.number)}
      where repo_id = ${repo.id} and sha = ${headSha}`;
    prAttributed = res.count;
  }

  let merged = 0;
  if (payload?.action === "closed" && pr.merged === true) {
    const mergeSha = String(pr.merge_commit_sha ?? "");
    if (SHA_RE.test(mergeSha)) {
      const res = await sql`
        update git_evidence set merged_at = coalesce(merged_at, now())
        where repo_id = ${repo.id} and sha = ${mergeSha}`;
      merged = res.count;
    }
  }
  return { ok: true, repository: fullName, pr_attributed: prAttributed, merged };
}

export async function handleGitHubWebhook(req: Request, cfg: Config): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  // Fail-closed: an ingestion path with no shared secret is worse than none.
  if (!cfg.githubWebhookSecret) {
    return Response.json(
      { error: "webhook_secret_not_configured", detail: "set KM_GITHUB_WEBHOOK_SECRET" },
      { status: 503 },
    );
  }
  if (!hasDb()) {
    return Response.json(
      { error: "degraded", detail: "DATABASE_URL not set; webhook ingestion unavailable" },
      { status: 503 },
    );
  }
  const body = await req.text();
  if (body.length > MAX_BODY_BYTES) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  if (!verifySignature(cfg.githubWebhookSecret, body, req.headers.get("x-hub-signature-256"))) {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  let payload: Payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const event = req.headers.get("x-github-event") ?? "";
  try {
    switch (event) {
      case "ping":
        return Response.json({ ok: true, event: "ping" });
      case "push":
        return Response.json(await handlePush(payload));
      case "check_suite":
        return Response.json(await handleCheckSuite(payload));
      case "pull_request":
        return Response.json(await handlePullRequest(payload));
      default:
        // Unknown events are acknowledged, never retried.
        return Response.json({ ok: true, ignored: "unsupported_event", event });
    }
  } catch (err) {
    // 5xx so GitHub retries (a lost push event is unrecoverable), but never
    // leak internals — Bun's default error page would ship the stack trace.
    console.error(`webhook ${event} failed: ${(err as Error)?.message ?? err}`);
    return Response.json({ error: "ingestion_failed" }, { status: 502 });
  }
}
