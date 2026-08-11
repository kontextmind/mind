/**
 * Native HTTP transport (docs/protocol.md): POST /v1/call {tool, args}.
 *
 * Same tools, same args, same responses as MCP — one dispatch, two doors.
 * This is the CLI's fast path: one authenticated round-trip, no protocol
 * handshake. MCP remains the agent integration surface (board stance).
 *
 * Auth, budgets, and claims are identical to /mcp: bearer token →
 * server-constructed claims → dispatch. Tool-level errors ride in the body
 * ({error, ...}) with ok:false; protocol errors are 4xx.
 */
import { authenticate } from "./auth";
import { budgetFor, principalLimited } from "./budgets";
import type { Config } from "./config";
import { hasDb } from "./db";
import { headShaOf } from "./app";
import { dispatchTool } from "./tool-dispatch";

export const MAX_V1_BODY = 1024 * 1024;

export async function handleV1Call(req: Request, cfg: Config): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }
  if (!hasDb()) {
    return Response.json(
      { ok: false, error: "degraded", detail: "DATABASE_URL not set" },
      { status: 503 },
    );
  }
  const authn = await authenticate(cfg, req);
  if (!authn.ok) {
    return Response.json(authn.body, { status: authn.status, headers: authn.headers });
  }
  if (principalLimited(authn.claims.sub, budgetFor(cfg))) {
    return Response.json(
      { ok: false, error: "rate_limited", detail: "per-identity budget exceeded" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const text = await req.text();
  if (text.length > MAX_V1_BODY) {
    return Response.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }
  let parsed: { tool?: string; args?: Record<string, unknown> };
  try {
    parsed = JSON.parse(text);
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!parsed.tool || typeof parsed.tool !== "string") {
    return Response.json({ ok: false, error: "tool required" }, { status: 400 });
  }

  const { body, isError } = await dispatchTool(
    authn.claims,
    cfg,
    parsed.tool,
    (parsed.args ?? {}) as Record<string, any>,
    headShaOf(cfg),
  );
  return Response.json({ ok: !isError, result: body });
}
