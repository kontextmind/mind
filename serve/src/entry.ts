#!/usr/bin/env node
/**
 * kontextmind — the server binary.
 *   kontextmind serve [--port 3000] [--data-dir DIR] [--db URL] [--hosted]
 *
 * Works under npx and bunx: plain Node ESM; Bun.serve is used only when
 * present. Data persists under one directory (default ~/.kontextmind):
 * mind git repo + server.json + database (per resolved tier).
 */
import { startServe } from "./serve";
import { nodeServe } from "./node-serve";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const [, , cmd, ...rest] = process.argv;

async function main(): Promise<void> {
  if (cmd !== "serve" || rest.includes("--help") || rest.includes("-h")) {
    console.log(`kontextmind — the persistent mind behind every AI agent

usage:
  kontextmind serve [options]        run the server (creates/uses the data dir)

options:
  --port N        port (default 13013, auto-advances if busy; 0 = ephemeral)
  --data-dir DIR  data directory (default $KONTEXTMIND_HOME or ~/.kontextmind)
  --db URL        database URL (else: docker container → local Postgres)
  --hosted        hosted mode (OAuth; requires KM_GITHUB_* env)

persistence (all under the data dir):
  mind/         git repo — the canonical knowledge; back this up
  server.json   generated token + db password; keep private
`);
    if (cmd !== "serve") return;
  }

  const explicit = flag(rest, "--port") ?? process.env.PORT;
  const requested = Number(explicit ?? 13013);
  const { info, handler } = await startServe({
    dataDir: flag(rest, "--data-dir"),
    databaseUrl: flag(rest, "--db") ?? process.env.DATABASE_URL ?? null,
    mode: rest.includes("--hosted") ? "hosted" : "demo",
  });

  // Default port 13013 is deliberately unusual; if ANYTHING holds it we
  // advance rather than fail (never collide with local services). An
  // explicit --port is honored exactly — the user asked for that port.
  const candidates: number[] = [];
  if (requested === 0) candidates.push(0);
  else if (explicit !== undefined) candidates.push(requested);
  else for (let i = 0; i < 10; i++) candidates.push(requested + i);

  const bun = (globalThis as Record<string, any>).Bun;
  const hostname = info.mode === "hosted" ? "0.0.0.0" : "127.0.0.1";
  let boundPort = -1;
  let runtime = "node";
  let lastErr: unknown = null;
  if (typeof bun?.serve === "function") {
    runtime = "bun";
    for (const port of candidates) {
      try {
        const server = bun.serve({ port, hostname, fetch: handler });
        boundPort = server.port;
        break;
      } catch (err) {
        lastErr = err;
        if (explicit !== undefined) throw err;
      }
    }
  } else {
    for (const port of candidates) {
      try {
        const s = await nodeServe(handler, port, hostname);
        boundPort = s.port;
        break;
      } catch (err) {
        lastErr = err;
        if (explicit !== undefined) throw err;
      }
    }
  }
  if (boundPort < 0) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  if (explicit === undefined && boundPort !== 13013 && requested !== 0) {
    console.log(`note: port 13013 was busy — serving on ${boundPort} instead`);
  }

  const dbNote =
    info.dbSource === "docker"
      ? "docker container kontextmind-pg (volume kontextmind-pgdata)"
      : info.dbSource === "env"
        ? "DATABASE_URL"
        : info.dbSource;
  console.log(`
kontextmind serving on http://${hostname}:${boundPort}${info.mode === "demo" ? "/mcp" : ""}
  runtime  ${runtime} · mode ${info.mode}
  token    ${info.token}
  data     ${info.dataDir}
    mind   ${info.mindPath} (git — canonical knowledge; back it up)
    db     ${dbNote}
`);
}

main().catch((err) => {
  console.error(`kontextmind: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
