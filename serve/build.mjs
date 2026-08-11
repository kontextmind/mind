#!/usr/bin/env bun
/**
 * Builds dist/serve.mjs — one Node-compatible bundle (deps external, npm
 * installs them). npx and bunx both work: the shebang is node, and the
 * runtime uses Bun.serve only when it exists.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
rmSync(join(here, "dist"), { recursive: true, force: true });
mkdirSync(join(here, "dist"), { recursive: true });

const res = spawnSync(
  "bun",
  [
    "build", "src/entry.ts", "--target=node", "--outdir", "dist",
    "--external", "@modelcontextprotocol/sdk",
    "--external", "postgres",
    // Platform binaries are optionalDependencies resolved at install time —
    // keep the dynamic imports dynamic.
    "--external", "embedded-postgres",
  ],
  { cwd: here, encoding: "utf8" },
);
if (res.status !== 0) {
  console.error(res.stderr);
  process.exit(1);
}

const body = readFileSync(join(here, "dist", "entry.js"), "utf8")
  .split("\n")
  .filter((l) => !l.startsWith("#!"))
  .join("\n");
writeFileSync(join(here, "dist", "serve.mjs"), `#!/usr/bin/env node\n${body}`);
rmSync(join(here, "dist", "entry.js"));
chmodSync(join(here, "dist", "serve.mjs"), 0o755);
console.log("built dist/serve.mjs");
