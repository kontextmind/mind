/**
 * kontextmind serve — zero-install server with one persistent data directory.
 *
 *   ~/.kontextmind/            (KONTEXTMIND_HOME or --data-dir)
 *     mind/                    git repo — CANONICAL knowledge; back this up
 *     server.json              generated token + db password; keep private
 *     db/                      (embedded-postgres tier, phase 2)
 *
 * Database resolution (honest precedence, persisted in every tier):
 *   1. DATABASE_URL / --db              → your Postgres, your rules
 *   2. docker available                 → managed kontextmind-pg container,
 *                                         named volume (survives rm of container)
 *   3. local Postgres (compose creds)   → dev convenience
 *   4. (phase 2) embedded-postgres      → zero-install tier
 * otherwise: a clear error listing the options. No silent surprises.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { runMigrations } from "../../server/src/migrate";
import { MIGRATIONS } from "./migrations-generated";
import { bootDemo, createFetch } from "../../server/src/app";
import { loadConfig } from "../../server/src/config";

export type DbSource = "env" | "docker" | "local-postgres" | "embedded";

export interface ServeInfo {
  dataDir: string;
  mindPath: string;
  databaseUrl: string;
  dbSource: DbSource;
  token: string;
  mode: "demo" | "hosted";
}

export interface ServerState {
  token: string;
  db_password: string;
  created_at: string;
}

const DOCKER_CONTAINER = "kontextmind-pg";
const DOCKER_PORT = 5433; // 5432 stays free for a dev compose stack
const DOCKER_VOLUME = "kontextmind-pgdata";
const LOCAL_PG_URL = "postgres://kontextmind:kontextmind-dev-only@localhost:5432/kontextmind";

export function defaultDataDir(): string {
  return process.env.KONTEXTMIND_HOME ?? join(homedir(), ".kontextmind");
}

const PURPOSE = `---
title: Purpose
status: verified
---

# Purpose

This mind belongs to this KontextMind instance. Decisions, learnings, and
process blocks harvested from real agent work land here: inbox drafts are
promoted through review; verified pages are team truth; supersede chains
retire stale knowledge with a pointer to what replaced it.

Git is canonical by commit SHA; the server index is disposable.
`;

/** Create the mind git repo on first run; leave it alone afterwards. */
export function ensureMindRepo(mindPath: string): "created" | "existing" {
  if (existsSync(join(mindPath, ".git"))) return "existing";
  mkdirSync(mindPath, { recursive: true });
  const git = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: mindPath, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  };
  git(["init", "-q"]);
  writeFileSync(join(mindPath, "purpose.md"), PURPOSE);
  for (const d of ["decisions", "evergreen", "inbox", "projects"]) {
    mkdirSync(join(mindPath, d), { recursive: true });
    writeFileSync(join(mindPath, d, ".gitkeep"), "");
  }
  git(["add", "-A"]);
  git(["-c", "user.name=KontextMind", "-c", "user.email=mind@kontextmind.local",
       "commit", "-q", "-m", "feat: bootstrap mind"]);
  return "created";
}

/** Generate-or-reuse server state (token + db password). Idempotent. */
export function ensureServerJson(path: string): { state: ServerState; created: boolean } {
  if (existsSync(path)) {
    return { state: JSON.parse(readFileSync(path, "utf8")) as ServerState, created: false };
  }
  const state: ServerState = {
    token: `km_tok_${randomBytes(16).toString("hex")}`,
    db_password: randomBytes(16).toString("hex"),
    created_at: new Date().toISOString(),
  };
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  return { state, created: true };
}

export function dockerAvailable(): boolean {
  try {
    return spawnSync("docker", ["info"], { encoding: "utf8", timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

export async function probePg(url: string): Promise<boolean> {
  const sql = postgres(url, { max: 1, connect_timeout: 3 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

async function ensureDockerPg(password: string): Promise<string> {
  const url = `postgres://kontextmind:${password}@localhost:${DOCKER_PORT}/kontextmind`;
  const sh = (args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
  const ps = sh(["ps", "-a", "--filter", `name=^/${DOCKER_CONTAINER}$`, "--format", "{{.Names}} {{.State}}"]);
  const line = (ps.stdout ?? "").trim();
  if (line.startsWith(DOCKER_CONTAINER)) {
    if (!line.includes("running")) sh(["start", DOCKER_CONTAINER]);
  } else {
    const run = sh([
      "run", "-d", "--name", DOCKER_CONTAINER,
      "-p", `${DOCKER_PORT}:5432`,
      "-v", `${DOCKER_VOLUME}:/var/lib/postgresql/data`,
      "-e", "POSTGRES_DB=kontextmind",
      "-e", "POSTGRES_USER=kontextmind",
      "-e", `POSTGRES_PASSWORD=${password}`,
      "pgvector/pgvector:pg16",
    ]);
    if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr.trim()}`);
  }
  for (let i = 0; i < 30; i++) {
    if (await probePg(url)) return url;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Postgres container did not become ready within 30s (${url})`);
}

export interface DbResolution {
  source: DbSource;
  url: string;
}

/** Pure precedence decision — injectable for tests. */
export function pickDbSource(opts: {
  envUrl?: string | null;
  docker?: boolean;
  localPgReachable?: boolean;
  embeddedAvailable?: boolean;
}): DbResolution | null {
  if (opts.envUrl) return { source: "env", url: opts.envUrl };
  if (opts.docker) return { source: "docker", url: "" }; // url assigned after container start
  if (opts.localPgReachable) return { source: "local-postgres", url: LOCAL_PG_URL };
  if (opts.embeddedAvailable) return { source: "embedded", url: "" }; // phase 2
  return null;
}

async function resolveDatabase(opts: {
  envUrl?: string | null;
  state: ServerState;
}): Promise<DbResolution> {
  const localPgReachable = await probePg(LOCAL_PG_URL);
  const choice = pickDbSource({
    envUrl: opts.envUrl,
    docker: dockerAvailable(),
    localPgReachable,
  });
  if (!choice) {
    throw new Error(
      [
        "No database available. Pick one:",
        "  1. Run Postgres 15+ and set DATABASE_URL (or use docker compose in the repo)",
        "  2. Install Docker — `kontextmind serve` manages its own container + volume",
        `  3. Start a local Postgres matching ${LOCAL_PG_URL.replace(/:[^:@]+@/, ":***@")}`,
      ].join("\n"),
    );
  }
  if (choice.source === "docker") {
    return { source: "docker", url: await ensureDockerPg(opts.state.db_password) };
  }
  return choice;
}

export interface StartServeOptions {
  dataDir?: string;
  databaseUrl?: string | null;
  mode?: "demo" | "hosted";
}

export interface StartedServe {
  info: ServeInfo;
  handler: (req: Request) => Response | Promise<Response>;
}

/** Everything needed to serve; does NOT bind a port (the entry does). */
export async function startServe(opts: StartServeOptions = {}): Promise<StartedServe> {
  const dataDir = resolve(opts.dataDir ?? defaultDataDir());
  mkdirSync(dataDir, { recursive: true });
  const mindPath = join(dataDir, "mind");
  const mindStatus = ensureMindRepo(mindPath);
  const { state, created } = ensureServerJson(join(dataDir, "server.json"));

  const db = await resolveDatabase({ envUrl: opts.databaseUrl ?? null, state });

  const admin = postgres(db.url, { max: 1, onnotice: () => {} });
  try {
    await runMigrations(admin, MIGRATIONS);
  } finally {
    await admin.end({ timeout: 5 });
  }

  // App config is env-driven; serve sets the environment, then loads.
  process.env.DATABASE_URL = db.url;
  process.env.KM_MIND_PATH = mindPath;
  process.env.KM_DEMO_TOKEN = state.token;
  process.env.KM_MODE = opts.mode ?? "demo";
  const cfg = loadConfig();
  if (cfg.mode === "demo") await bootDemo(cfg);

  if (mindStatus === "created") console.log(`bootstrapped mind at ${mindPath}`);
  if (created) console.log(`generated server state at ${join(dataDir, "server.json")}`);

  return {
    info: {
      dataDir,
      mindPath,
      databaseUrl: db.url,
      dbSource: db.source,
      token: state.token,
      mode: cfg.mode,
    },
    handler: createFetch(cfg),
  };
}
