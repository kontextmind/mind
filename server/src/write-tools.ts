/**
 * Write-path tools (phase 1b): km_append + km_review.
 * Flow: harvest → gate 2 scan → inbox draft (direct commit) → review queue →
 * promote = direct commit to curated tree. No PR barrage (docs/trust-modes.md).
 */
import { adminDb, withClaims, type KmClaims } from "./db";
import { DEMO_NAMESPACE, DEMO_REPO, type Config } from "./config";
import { scanContent, isLowRiskLearning } from "./secrets";
import { writeDraft, promoteDraft, supersede, assertSupersedable } from "./indexer/write";
import { ingestRepo } from "./indexer/ingest";
import { kmSearch } from "./tools";

export interface WriteCtx {
  cfg: Config;
  sessionId: string;
}

function newReviewId(): string {
  return `rev_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function denylist(): string[] {
  return (process.env.KM_DENYLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function namespaceSlug(claims: KmClaims, namespaceId: string): Promise<string> {
  return withClaims(claims, async (tx) => {
    const rows = await tx`select slug from namespaces where id = ${namespaceId}`;
    return (rows[0]?.slug as string) ?? "unknown";
  });
}

function targetDirFor(classification: string, nsSlug: string): string {
  return classification === "org" ? "evergreen" : `projects/${nsSlug}/learnings`;
}

async function reindex(cfg: Config): Promise<void> {
  if (!cfg.mindPath) return;
  const sql = adminDb();
  // 1a/demo: the mind repo is the seeded demo repo — never `limit 1`, which
  // drifts to an arbitrary repo once multiple projects are registered.
  // Hosted mode must resolve the repo from claims when per-namespace repos land.
  await ingestRepo(sql, {
    repoId: DEMO_REPO,
    namespaceId: DEMO_NAMESPACE,
    repoPath: cfg.mindPath,
  });
}

export interface AppendArgs {
  title: string;
  content: string;
  classification?: "project" | "org";
  supersedes?: string;
}

export async function kmAppend(
  claims: KmClaims,
  args: AppendArgs,
  ctx: WriteCtx,
): Promise<Record<string, unknown>> {
  if (!ctx.cfg.mindPath) throw new Error("no mind repo configured (KM_MIND_PATH)");
  const classification = args.classification ?? "project";
  const namespaceId = claims.namespaces[0];
  if (!namespaceId) throw new Error("no namespace in claims");

  // Validate the supersede target before anything is committed — a bad target
  // should not leave a draft behind that can never be promoted.
  if (args.supersedes) assertSupersedable(ctx.cfg.mindPath, args.supersedes);

  // Gate 2 — deterministic secret scan BEFORE anything is committed.
  const scan = scanContent(`${args.title}\n${args.content}`, { denylist: denylist() });
  if (!scan.clean) {
    // Bind every sql`` interpolation to a plain identifier first.
    // Bun's tagged-template parser (1.3.x) rejects nested `${}`, object
    // literals, and `${x}::cast` inside postgres.js fragments.
    const revId = newReviewId();
    const quarantineTitle = `quarantined: ${args.title}`;
    // Pass the object, never a pre-stringified string: postgres.js applies its
    // own JSON.stringify once PG infers the param as jsonb, so a JSON string
    // lands as a jsonb *string scalar* and `body->>'key'` reads NULL.
    const quarantineBody = {
      rules: scan.findings.map((f) => f.rule),
      title: args.title,
    };
    const author = claims.sub;
    const reviewId = await withClaims(claims, async (tx) => {
      const bodyJson = tx.json(quarantineBody);
      const rows = await tx`
        insert into review_items (id, namespace_id, kind, title, body, author)
        values (${revId}, ${namespaceId}, 'suspicious', ${quarantineTitle}, ${bodyJson}, ${author})
        returning id`;
      return rows[0].id as string;
    });
    return {
      status: "quarantined",
      review_id: reviewId,
      rules: [...new Set(scan.findings.map((f) => f.rule))],
      detail: "content blocked by secret gate; draft was NOT committed",
    };
  }

  // Dedupe awareness: surface near-duplicates for the agent/human to judge.
  const dedupe = await kmSearch(claims, { query: args.title, limit: 3 });

  const nsSlug = await namespaceSlug(claims, namespaceId);
  const draft = writeDraft({
    repoPath: ctx.cfg.mindPath,
    title: args.title,
    body: args.content,
    author: claims.sub,
    sessionId: ctx.sessionId,
    classification,
  });

  // The supersede edge is recorded in the review body and applied on PROMOTION
  // (below / in kmReview) — never here. A draft is unreviewed: pointing a
  // curated page at one inverts the trust model, and the pointer dangles if
  // the draft is later skipped.

  // Relaxed mode: auto-promote low-risk one-liners (docs/trust-modes.md).
  const autoPromote = ctx.cfg.trustMode === "relaxed" && isLowRiskLearning(args.content);
  let finalPath = draft.path;
  let status: string = "draft";

  if (autoPromote) {
    const promoted = promoteDraft({
      repoPath: ctx.cfg.mindPath,
      draftPath: draft.path,
      targetDir: targetDirFor(classification, nsSlug),
      sessionId: ctx.sessionId,
    });
    finalPath = promoted.path;
    status = "promoted";
    if (args.supersedes) {
      supersede({
        repoPath: ctx.cfg.mindPath,
        oldPath: args.supersedes,
        newPath: promoted.path,
        sessionId: ctx.sessionId,
      });
    }
  }

  await reindex(ctx.cfg); // read-your-writes

  // Pre-bind sql`` args — no ternaries / casts inside the fragment (Bun 1.3.x).
  const revId = newReviewId();
  const draftBody = {
    draft_path: draft.path,
    classification,
    supersedes: args.supersedes ?? null,
  };
  const author = claims.sub;
  const title = args.title;
  const resolvedAt = autoPromote ? new Date() : null;
  const resolvedBy = autoPromote ? "kontextmind" : null;
  const verdict = autoPromote ? "promote" : null;
  const promotedTo = autoPromote ? finalPath : null;
  const reviewId = await withClaims(claims, async (tx) => {
    const bodyJson = tx.json(draftBody);
    const rows = await tx`
      insert into review_items
        (id, namespace_id, kind, title, body, author,
         resolved_at, resolved_by, verdict, promoted_to)
      values
        (${revId}, ${namespaceId}, 'learning', ${title}, ${bodyJson}, ${author},
         ${resolvedAt}, ${resolvedBy}, ${verdict}, ${promotedTo})
      returning id`;
    return rows[0].id as string;
  });

  return {
    status,
    path: finalPath,
    review_id: reviewId,
    commit_sha: draft.commitSha,
    dedupe_hits: dedupe.hits.map((h) => ({ path: h.path, score: h.score })),
  };
}

export interface ReviewArgs {
  action: "list" | "resolve";
  id?: string;
  verdict?: "promote" | "research" | "skip";
  reason?: string;
  kind?: string;
}

export async function kmReview(
  claims: KmClaims,
  args: ReviewArgs,
  ctx: WriteCtx,
): Promise<Record<string, unknown>> {
  if (args.action === "list") {
    return withClaims(claims, async (tx) => {
      const rows = args.kind
        ? await tx`select id, kind, title, body, author, created_at, resolved_at, verdict, promoted_to
            from review_items where kind = ${args.kind}
            order by resolved_at asc nulls first, created_at desc limit 25`
        : await tx`select id, kind, title, body, author, created_at, resolved_at, verdict, promoted_to
            from review_items
            order by resolved_at asc nulls first, created_at desc limit 25`;
      return { items: rows };
    });
  }

  // resolve
  if (!args.id || !args.verdict) throw new Error("resolve requires id and verdict");
  const itemId = args.id;
  const verdict = args.verdict;
  if (verdict !== "promote" && !args.reason) {
    throw new Error(`verdict '${verdict}' requires a reason`);
  }

  const item = await withClaims(claims, async (tx) => {
    const rows = await tx`select * from review_items where id = ${itemId}`;
    return rows[0];
  });
  if (!item) throw new Error(`review item not found: ${itemId}`);
  if (item.resolved_at) throw new Error(`review item already resolved: ${itemId}`);

  let promotedTo: string | null = null;

  if (verdict === "promote") {
    if (!ctx.cfg.mindPath) throw new Error("no mind repo configured");
    // jsonb may arrive as a raw string depending on the driver path.
    const rawBody = item.body;
    const body = (typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody) as {
      draft_path?: string;
      classification?: string;
      supersedes?: string | null;
    };
    if (!body.draft_path) {
      throw new Error(
        item.kind === "learning"
          ? `review item ${itemId} has a malformed body (no draft_path)`
          : `review item ${itemId} is kind '${item.kind}' and carries no draft to promote`,
      );
    }
    // Refuse an illegal supersede BEFORE promoting — a throw after
    // promoteDraft() would leave the page promoted with the item still pending.
    if (body.supersedes) assertSupersedable(ctx.cfg.mindPath, body.supersedes);
    const nsSlug = await namespaceSlug(claims, item.namespace_id as string);
    const promoted = promoteDraft({
      repoPath: ctx.cfg.mindPath,
      draftPath: body.draft_path,
      targetDir: targetDirFor(body.classification ?? "project", nsSlug),
      sessionId: ctx.sessionId,
    });
    promotedTo = promoted.path;
    // Apply the supersede edge only now that the replacement is curated.
    if (body.supersedes) {
      supersede({
        repoPath: ctx.cfg.mindPath,
        oldPath: body.supersedes,
        newPath: promoted.path,
        sessionId: ctx.sessionId,
      });
    }
    await reindex(ctx.cfg);
  }

  const resolver = claims.sub;
  const resolveVerdict = args.verdict;
  const reason = args.reason ?? null;
  const resolveId = args.id;
  await withClaims(claims, async (tx) => {
    await tx`
      update review_items set
        resolved_at = now(),
        resolved_by = ${resolver},
        verdict = ${resolveVerdict},
        verdict_reason = ${reason},
        promoted_to = ${promotedTo}
      where id = ${resolveId}`;
  });

  return { id: resolveId, verdict: resolveVerdict, promoted_to: promotedTo };
}
