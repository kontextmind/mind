/**
 * Git access for the indexer — shells out to git (no dependency, works on
 * Windows/macOS/Linux wherever git is installed; the demo compose image
 * includes git).
 */
import { spawnSync } from "node:child_process";

export class GitError extends Error {}

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new GitError(`git ${args.join(" ")} failed: ${res.stderr.trim()}`);
  }
  return res.stdout;
}

export function headSha(repoPath: string): string {
  return git(repoPath, "rev-parse", "HEAD").trim();
}

export interface TreeEntry {
  path: string;
  blobSha: string;
}

/** All markdown files at HEAD with blob SHAs (SHA-first indexing). */
export function tree(repoPath: string): TreeEntry[] {
  const out = git(repoPath, "ls-tree", "-r", "HEAD", "--format=%(objectname) %(path)");
  return out
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const i = l.indexOf(" ");
      return { blobSha: l.slice(0, i), path: l.slice(i + 1) };
    })
    .filter((e) => e.path.endsWith(".md"));
}

export function readBlob(repoPath: string, blobSha: string): string {
  return git(repoPath, "cat-file", "blob", blobSha);
}

export function commitMessage(repoPath: string, sha: string): string {
  return git(repoPath, "log", "-1", "--format=%B", sha);
}

/** Paths changed between two SHAs (reconcile deltas). */
export function changedPaths(repoPath: string, fromSha: string, toSha: string): string[] {
  const out = git(repoPath, "diff", "--name-only", fromSha, toSha);
  return out.split("\n").filter((p) => p.trim().endsWith(".md"));
}

export function isRepo(path: string): boolean {
  try {
    git(path, "rev-parse", "--git-dir");
    return true;
  } catch {
    return false;
  }
}
