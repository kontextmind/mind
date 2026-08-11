#!/usr/bin/env bun
/**
 * One-command release: bumps every package in lockstep, builds both
 * publishable bundles, publishes to npm, tags, and cuts the GitHub release.
 *
 *   bun run release patch|minor|major|x.y.z [--dry-run]
 *
 * Requires: git clean + on main + up to date, npm auth that can publish
 * (granular token with 2FA bypass — see docs/releasing.md).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const targets = [
  { name: "root", dir: root, publish: false },
  { name: "server", dir: join(root, "server"), publish: false },
  { name: "@kontextmind/cli", dir: join(root, "cli"), publish: true },
  { name: "kontextmind (serve)", dir: join(root, "serve"), publish: true },
];

function sh(cmd: string[], cwd: string, dry: boolean): void {
  console.log(`  ${dry ? "[dry] " : ""}${cmd.join(" ")}`);
  if (dry) return;
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`failed: ${cmd.join(" ")}`);
    process.exit(1);
  }
}

function readVersion(dir: string): string {
  return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string })
    .version;
}

function bump(version: string, kind: string): string {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  const [ma, mi, pa] = version.split(".").map(Number);
  if (kind === "major") return `${ma + 1}.0.0`;
  if (kind === "minor") return `${ma}.${mi + 1}.0`;
  if (kind === "patch") return `${ma}.${mi}.${pa + 1}`;
  console.error(`usage: bun run release patch|minor|major|x.y.z [--dry-run]`);
  process.exit(1);
}

const kind = process.argv[2];
const dry = process.argv.includes("--dry-run");
if (!kind) {
  console.error(`usage: bun run release patch|minor|major|x.y.z [--dry-run]`);
  process.exit(1);
}

// Pre-flight: clean tree, on main, in sync — a release should never carry
// uncommitted drift.
const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (status.stdout.trim()) {
  console.error("working tree not clean — commit or stash first");
  process.exit(1);
}
const branch = spawnSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" });
if (branch.stdout.trim() !== "main") {
  console.error("releases cut from main only");
  process.exit(1);
}
const behind = spawnSync("git", ["rev-list", "--count", "main..origin/main"], {
  cwd: root,
  encoding: "utf8",
});
if (parseInt(behind.stdout || "0", 10) > 0) {
  console.error("main is behind origin — pull first");
  process.exit(1);
}

const current = readVersion(targets[0].dir);
const next = bump(current, kind);
console.log(`releasing v${next} (from v${current})${dry ? " — DRY RUN" : ""}\n`);

// 1. Lockstep version bump across every package.
for (const t of targets) {
  const p = join(t.dir, "package.json");
  const j = JSON.parse(readFileSync(p, "utf8"));
  j.version = next;
  writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`);
  console.log(`bumped ${t.name} → ${next}`);
}

// 2. Build both publishable bundles.
sh(["bun", "run", "build"], join(root, "cli"), dry);
sh(["bun", "run", "build"], join(root, "serve"), dry);

// 3. Publish.
for (const t of targets.filter((t) => t.publish)) {
  sh(["npm", "publish", "--access", "public"], t.dir, dry);
}

// 4. Tag + push.
sh(["git", "add", "-A"], root, dry);
sh(["git", "commit", "-m", `chore(release): v${next}`], root, dry);
sh(["git", "tag", "-a", `v${next}`, "-m", `v${next}`], root, dry);
sh(["git", "push", "origin", "main", "--tags"], root, dry);

// 5. GitHub release (notes via gh).
sh(
  [
    "gh",
    "release",
    "create",
    `v${next}`,
    "--title",
    `v${next}`,
    "--generate-notes",
  ],
  root,
  dry,
);

console.log(`\nv${next} released${dry ? " (dry run — nothing actually happened)" : ""}.`);
