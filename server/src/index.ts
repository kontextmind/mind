import { loadConfig } from "./config";
import { hasDb } from "./db";
import { bootDemo, createFetch } from "./app";

const cfg = loadConfig();

if (cfg.mode === "demo" && hasDb()) {
  await bootDemo(cfg);
}

const fetchHandler = createFetch(cfg);

// Demo binds localhost-only on a bare host; inside a container the network
// boundary is the container itself, so KM_HOST=0.0.0.0 makes the port map work.
const hostname = cfg.mode === "hosted" ? "0.0.0.0" : (process.env.KM_HOST ?? "127.0.0.1");

const server = Bun.serve({
  port: cfg.port,
  hostname,
  fetch: fetchHandler,
});

console.log(`kontextmind ${cfg.mode} listening on ${hostname}:${server.port}`);
if (cfg.mode === "demo") {
  console.log(`MCP endpoint: http://127.0.0.1:${server.port}/mcp`);
  console.log(`Demo token:   ${cfg.demoToken}`);
}
