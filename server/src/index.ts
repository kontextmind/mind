import { hasDb } from "./db";
import { mcpHandler } from "./mcp";

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        service: "kontextmind",
        version: "0.0.0",
        database: hasDb() ? "configured" : "absent (degraded: healthz only)",
      });
    }

    // OAuth discovery endpoints (MCP authorization spec) land in phase 1a:
    //   /.well-known/oauth-protected-resource
    //   /.well-known/oauth-authorization-server
    if (url.pathname.startsWith("/.well-known/")) {
      return Response.json(
        { error: "not_implemented", phase: "1a" },
        { status: 501 },
      );
    }

    if (url.pathname === "/mcp") {
      return mcpHandler(req);
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },
});

console.log(`kontextmind listening on :${server.port}`);
