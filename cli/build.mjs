#!/usr/bin/env bun
/**
 * Build the publishable CLI: one node-compatible bundle (MCP SDK external —
 * npm installs it), shebang re-attached, source shebang stripped.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
rmSync(join(here, "dist"), { recursive: true, force: true });
mkdirSync(join(here, "dist"), { recursive: true });

const res = spawnSync(
  "bun",
  ["build", "src/index.ts", "--target=node", "--outdir", "dist", "--external", "@modelcontextprotocol/sdk"],
  { cwd: here, encoding: "utf8" },
);
if (res.status !== 0) {
  console.error(res.stderr);
  process.exit(1);
}

// bun preserves the entry's shebang inside the bundle — strip every shebang
// line and put exactly one (node) at the top.
const body = readFileSync(join(here, "dist", "index.js"), "utf8")
  .split("\n")
  .filter((l) => !l.startsWith("#!"))
  .join("\n");
writeFileSync(join(here, "dist", "index.mjs"), `#!/usr/bin/env node\n${body}`);
rmSync(join(here, "dist", "index.js"));
chmodSync(join(here, "dist", "index.mjs"), 0o755);
console.log("built dist/index.mjs");
