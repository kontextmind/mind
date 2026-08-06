/**
 * Mind write operations (phase 1b).
 * Every mutation is a git commit authored by KontextMind carrying the
 * KM-Session evidence trailer (docs/session-spine.md) — we dogfood our own
 * spec. Secret gate 2 runs BEFORE any of these are called (tools.ts).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

const IDENTITY = {
  GIT_AUTHOR_NAME: "KontextMind",
  GIT_AUTHOR_EMAIL: "mind@kontextmind.local",
  GIT_COMMITTER_NAME: "KontextMind",
  GIT_COMMITTER_EMAIL: "mind@kontextmind.local",
};

function git(repoPath: string, args: string[], sessionId?: string): string {
  const res = spawnSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    env: { ...process.env, ...IDENTITY },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

function commit(repoPath: string, message: string, sessionId?: string): string {
  const args = ["commit", "-q", "-m", message];
  if (sessionId) args.push("-m", `KM-Session: ${sessionId}`);
  git(repoPath, args, sessionId);
  return git(repoPath, ["rev-parse", "HEAD"]);
}

/** mkdir -p that tolerates an existing dir (Bun/Windows recursive-mkdir EEXIST quirk). */
function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

interface FrontmatterFields {
  title: string;
  status: string;
  author: string;
  created: string;
  [k: string]: string;
}

function renderFrontmatter(fields: FrontmatterFields, body: string): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${/[:"'[\]{}#]/.test(v) ? `'${v.replace(/'/g, "''")}'` : v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

/** Split a page into its frontmatter fields and body. */
export function parseFrontmatter(src: string): {
  fields: Record<string, string>;
  body: string;
} {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const body = m ? src.slice(m[0].length) : src;
  const fields: Record<string, string> = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (kv) fields[kv[1]] = kv[2].replace(/^['"]|['"]$/g, "");
    }
  }
  return { fields, body };
}

/** Rewrite/add frontmatter fields on an existing page, preserving body. */
export function rewriteFrontmatter(src: string, updates: Record<string, string | null>): string {
  const { fields, body } = parseFrontmatter(src);
  for (const [k, v] of Object.entries(updates)) {
    if (v === null) delete fields[k];
    else fields[k] = v;
  }
  return renderFrontmatter(fields as FrontmatterFields, body);
}

export interface DraftResult {
  path: string;
  commitSha: string;
}

/** Write a harvest draft to inbox/drafts/ and commit it. */
export function writeDraft(opts: {
  repoPath: string;
  title: string;
  body: string;
  author: string;
  sessionId?: string;
  classification: string;
}): DraftResult {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rel = `inbox/drafts/${stamp}-${slugify(opts.title)}.md`;
  const abs = join(opts.repoPath, rel);
  ensureDir(dirname(abs));
  const content = renderFrontmatter(
    {
      title: opts.title,
      status: "draft",
      author: opts.author,
      created: new Date().toISOString().slice(0, 10),
      classification: opts.classification,
    },
    opts.body,
  );
  writeFileSync(abs, content);
  git(opts.repoPath, ["add", rel]);
  const sha = commit(opts.repoPath, `draft: ${opts.title}`, opts.sessionId);
  return { path: rel, commitSha: sha };
}

export interface PromoteResult {
  path: string;
  commitSha: string;
}

/** Promote a draft: status → verified, move to curated tree, commit. */
export function promoteDraft(opts: {
  repoPath: string;
  draftPath: string;
  targetDir: string; // e.g. projects/demo/learnings or evergreen
  sessionId?: string;
}): PromoteResult {
  const absDraft = join(opts.repoPath, opts.draftPath);
  if (!existsSync(absDraft)) throw new Error(`draft not found: ${opts.draftPath}`);
  const src = readFileSync(absDraft, "utf8");
  const updated = rewriteFrontmatter(src, {
    status: "verified",
    promoted_at: new Date().toISOString().slice(0, 10),
  });
  const file = opts.draftPath.split("/").pop()!;
  const rel = `${opts.targetDir.replace(/\/+$/, "")}/${file}`;
  const abs = join(opts.repoPath, rel);
  ensureDir(dirname(abs));
  writeFileSync(abs, updated);
  unlinkSync(absDraft);
  git(opts.repoPath, ["add", "-A", opts.draftPath, rel]);
  const titleMatch = updated.match(/^title:\s*(.+)$/m);
  const sha = commit(
    opts.repoPath,
    `promote: ${titleMatch?.[1] ?? file}`,
    opts.sessionId,
  );
  return { path: rel, commitSha: sha };
}

/** True when `rel` names a page that exists in the mind. */
export function pageExists(repoPath: string, rel: string): boolean {
  return existsSync(join(repoPath, rel));
}

/**
 * Throw if `oldPath` cannot be superseded. Call this BEFORE any commit that
 * would be left half-applied by a late refusal — promoting a draft and only
 * then discovering the edge is illegal leaves a promoted page behind with the
 * review item still pending.
 */
export function assertSupersedable(repoPath: string, oldPath: string, force = false): void {
  if (oldPath.startsWith("inbox/")) {
    throw new Error(`cannot supersede an inbox draft: ${oldPath}`);
  }
  const abs = join(repoPath, oldPath);
  if (!existsSync(abs)) throw new Error(`supersedes target not found: ${oldPath}`);
  const existing = parseFrontmatter(readFileSync(abs, "utf8")).fields.superseded_by;
  if (existing && !force) {
    throw new Error(
      `${oldPath} is already superseded by ${existing}; refusing to repoint it (pass force to override)`,
    );
  }
}

/**
 * Mark an old page superseded by a new one (frontmatter only), commit.
 *
 * A supersede edge is curated content: overwriting an existing one silently
 * loses a decision someone already recorded. Refuse unless `force` says a
 * steward meant it. `newPath` must be a curated page — pointing a decision at
 * an unreviewed inbox draft inverts the trust model, and the pointer dangles
 * if that draft is later skipped.
 */
export function supersede(opts: {
  repoPath: string;
  oldPath: string;
  newPath: string;
  sessionId?: string;
  force?: boolean;
}): string {
  const abs = join(opts.repoPath, opts.oldPath);
  if (!existsSync(abs)) throw new Error(`page not found: ${opts.oldPath}`);
  if (opts.newPath.startsWith("inbox/")) {
    throw new Error(
      `refusing to supersede ${opts.oldPath} with an inbox draft (${opts.newPath}); promote it first`,
    );
  }
  const src = readFileSync(abs, "utf8");
  const existing = parseFrontmatter(src).fields.superseded_by;
  if (existing && existing !== opts.newPath && !opts.force) {
    throw new Error(
      `${opts.oldPath} is already superseded by ${existing}; refusing to repoint it at ${opts.newPath} (pass force to override)`,
    );
  }
  if (existing === opts.newPath) return git(opts.repoPath, ["rev-parse", "HEAD"]); // already recorded
  writeFileSync(abs, rewriteFrontmatter(src, { superseded_by: opts.newPath }));
  git(opts.repoPath, ["add", opts.oldPath]);
  return commit(opts.repoPath, `supersede: ${opts.oldPath} -> ${opts.newPath}`, opts.sessionId);
}
