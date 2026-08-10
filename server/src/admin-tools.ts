/**
 * Admin-flavored tools: km_reindex, km_projects, km_project_add, km_invite.
 * Read paths run claims-bound under RLS; index writes run on the admin
 * connection (same split as the indexer, docs/threat-model.md B2).
 */
import { createHash } from "node:crypto";
import { adminDb, withClaims, type KmClaims } from "./db";
import { DEMO_REPO, type Config } from "./config";
import { reconcileRepo, type ReconcileResult } from "./indexer/reconcile";
import { ingestRepo, type IngestStats } from "./indexer/ingest";
import { isRepo } from "./indexer/git";

function requireSteward(claims: KmClaims): void {
  const ok = Object.values(claims.roles).some((r) => r === "steward" || r === "owner");
  if (!ok) throw new Error("requires steward or owner role");
}

interface RepoRow {
  id: string;
  github_full: string;
  display_name: string | null;
  local_path: string | null;
  head_sha: string | null;
  indexed_at: Date | null;
}

/** Resolve the repo an admin op targets: explicit arg, else the seeded mind repo. */
async function resolveRepo(
  claims: KmClaims,
  cfg: Config,
  project?: string,
): Promise<RepoRow> {
  if (!project && cfg.mode !== "demo") {
    // Hosted mode has no single configured mind repo; the caller must name one.
    throw new Error("project is required in hosted mode");
  }
  const fallback = project ?? DEMO_REPO;
  const rows = await withClaims(claims, async (tx) => {
    return tx`select id, github_full, display_name, local_path, head_sha, indexed_at
      from repos where id = ${fallback} or github_full = ${fallback} limit 1`;
  });
  const row = rows[0] as RepoRow | undefined;
  if (!row) {
    throw new Error(project ? `project not found: ${project}` : "no projects registered");
  }
  return row;
}

function repoPathFor(row: RepoRow, cfg: Config): string {
  const p = row.local_path ?? cfg.mindPath;
  if (!p) throw new Error(`project ${row.id} has no local path (not reindexable in this mode)`);
  return p;
}

// ---------------------------------------------------------------------------
// km_reindex
// ---------------------------------------------------------------------------

export async function kmReindex(
  claims: KmClaims,
  args: { project?: string },
  ctx: { cfg: Config },
): Promise<ReconcileResult> {
  const row = await resolveRepo(claims, ctx.cfg, args.project);
  const repoPath = repoPathFor(row, ctx.cfg);
  if (!isRepo(repoPath)) throw new Error(`not a git repo: ${repoPath}`);
  const ns = claims.namespaces[0];
  if (!ns) throw new Error("no namespace in claims");
  // Index writes run on the admin connection; reconcile is idempotent.
  return reconcileRepo(adminDb(), {
    repoId: row.id,
    namespaceId: ns,
    repoPath,
    repair: true,
  });
}

// ---------------------------------------------------------------------------
// km_projects
// ---------------------------------------------------------------------------

export async function kmProjects(
  claims: KmClaims,
  ctx: { cfg: Config },
): Promise<Record<string, unknown>> {
  return withClaims(claims, async (tx) => {
    const rows = await tx`select id, github_full, display_name, local_path, head_sha, indexed_at
      from repos order by id`;
    const projects = rows.map((r) => ({
      id: r.id as string,
      name: (r.display_name as string | null) ?? (r.github_full as string),
      github_full: r.github_full as string,
      reindexable: Boolean(r.local_path) || Boolean(ctx.cfg.mindPath),
      head_sha: (r.head_sha as string | null) ?? null,
      indexed_at: r.indexed_at ? (r.indexed_at as Date).toISOString() : null,
    }));
    // Demo mode pins the seeded mind repo as active; hosted mode has no
    // session pinning by design — the first registered project is reported.
    const active =
      (ctx.cfg.mode === "demo" && projects.find((p) => p.id === DEMO_REPO)?.id) ||
      projects[0]?.id ||
      null;
    return {
      projects,
      active,
      count: projects.length,
    };
  });
}

// ---------------------------------------------------------------------------
// km_project_add
// ---------------------------------------------------------------------------

export interface ProjectAddArgs {
  name: string;
  path?: string;
  github_full?: string;
}

export async function kmProjectAdd(
  claims: KmClaims,
  args: ProjectAddArgs,
  ctx: { cfg: Config },
): Promise<Record<string, unknown>> {
  requireSteward(claims);
  const ns = claims.namespaces[0];
  if (!ns) throw new Error("no namespace in claims");
  if (args.path && !isRepo(args.path)) {
    throw new Error(`not a git repo: ${args.path} (omit path to register without indexing)`);
  }

  const repoId = `repo_${createHash("sha1").update(`${claims.org}:${args.name}`).digest("hex").slice(0, 22)}`;
  const githubFull = args.github_full ?? `local/${args.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const localPath = args.path ?? null;
  const displayName = args.name;

  const row = await withClaims(claims, async (tx) => {
    const rows = await tx`insert into repos (id, org_id, github_full, display_name, local_path, default_namespace_id)
      values (${repoId}, ${claims.org}, ${githubFull}, ${displayName}, ${localPath}, ${ns})
      on conflict (id) do update set
        display_name = excluded.display_name,
        local_path = coalesce(excluded.local_path, repos.local_path),
        default_namespace_id = coalesce(repos.default_namespace_id, excluded.default_namespace_id)
      returning id, github_full, display_name, local_path, head_sha, indexed_at`;
    return rows[0] as RepoRow;
  });

  let indexed: IngestStats | null = null;
  if (args.path) {
    indexed = await ingestRepo(adminDb(), { repoId: row.id, namespaceId: ns, repoPath: args.path });
  }

  return {
    project: {
      id: row.id,
      name: row.display_name ?? row.github_full,
      github_full: row.github_full,
    },
    namespace_id: ns,
    indexed: indexed
      ? { pages: indexed.pages, chunks: indexed.chunks, head_sha: indexed.headSha }
      : null,
  };
}

// ---------------------------------------------------------------------------
// km_invite
// ---------------------------------------------------------------------------

export interface InviteArgs {
  email: string;
  role?: "member" | "steward" | "owner";
}

export async function kmInvite(
  claims: KmClaims,
  args: InviteArgs,
): Promise<Record<string, unknown>> {
  requireSteward(claims);
  if (!args.email.includes("@")) throw new Error(`invalid email: ${args.email}`);
  const role = args.role ?? "member";
  const inviteId = `inv_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const token = `kmi_${crypto.randomUUID().replace(/-/g, "")}`;
  const invitedBy = claims.sub;
  const email = args.email;

  const row = await withClaims(claims, async (tx) => {
    const rows = await tx`insert into invites (id, org_id, email, role, token, invited_by)
      values (${inviteId}, ${claims.org}, ${email}, ${role}, ${token}, ${invitedBy})
      on conflict (org_id, email) do update set
        role = excluded.role, token = excluded.token,
        invited_by = excluded.invited_by, created_at = now(),
        expires_at = now() + interval '7 days', accepted_at = null
      returning id, expires_at`;
    return rows[0];
  });

  return {
    invite_id: row.id as string,
    email,
    role,
    expires_at: (row.expires_at as Date).toISOString(),
    // 1a: no SMTP — the issuer delivers this link out-of-band.
    delivery: "link",
    accept_url: `/accept-invite?token=${token}`,
  };
}
