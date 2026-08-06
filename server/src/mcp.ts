/**
 * MCP endpoint stub (phase 0).
 *
 * Phase 1a implements Streamable HTTP MCP here with:
 *  - OAuth 2.1 bearer validation (audience-bound per RFC 8707)
 *  - per-request claims binding (db.withClaims)
 *  - tools: km_search, km_read, km_list, km_status
 * Phase 1b adds: km_append, km_review (+ secret gates), agent identities.
 * Phase 5 adds: km_work_*, km_handoff_*. Phase 6 adds: km_insights.
 *
 * Tool schemas are protocol surface — see docs/protocol.md. Breaking changes
 * require a protocol version bump.
 */
export async function mcpHandler(req: Request): Promise<Response> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return new Response(null, {
      status: 401,
      headers: {
        // RFC 9728: point clients at protected-resource metadata
        "WWW-Authenticate":
          'Bearer resource_metadata="https://mcp.kontextmind.com/.well-known/oauth-protected-resource"',
      },
    });
  }
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32601, message: "kontextmind phase 0: MCP not yet implemented" },
      id: null,
    },
    { status: 501 },
  );
}
