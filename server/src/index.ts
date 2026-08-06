import { loadConfig } from "./config";
import { hasDb } from "./db";
import { bootDemo, createFetch } from "./app";

const cfg = loadConfig();

if (cfg.mode === "demo" && hasDb()) {
  await bootDemo(cfg);
}

const fetchHandler = createFetch(cfg);

const server = Bun.serve({
  port: cfg.port,
  hostname: cfg.mode === "demo" ? "127.0.0.1" : "0.0.0.0",
  fetch: fetchHandler,
});

console.log(
  `kontextmind ${cfg.mode} listening on ${cfg.mode === "demo" ? "127.0.0.1" : "0.0.0.0"}:${server.port}`,
);
if (cfg.mode === "demo") {
  console.log(`MCP endpoint: http://127.0.0.1:${server.port}/mcp`);
  console.log(`Demo token:   ${cfg.demoToken}`);
}
