/**
 * Single dispatch for every km_* tool — shared by the MCP endpoint and the
 * native /v1 HTTP API (docs/protocol.md). Same functions, same args, same
 * responses; session issuance, event recording, and error wrapping happen
 * here exactly once.
 *
 * Board stance: MCP is the agent integration surface; the CLI uses /v1 for
 * speed (one round-trip, no handshake). One source of truth either way.
 */
import type { Config } from "./config";
import type { KmClaims } from "./db";
import * as tools from "./tools";
import { kmAppend, kmReview } from "./write-tools";
import { kmInvite, kmProjectAdd, kmProjects, kmReindex } from "./admin-tools";
import { kmInsights } from "./insights";
import { argsHash, recordEvent, runEventDetectors } from "./events";
import { embedderFor } from "./embeddings";
import { kmHandoffLoad, kmHandoffSave, kmWorkCurrent, kmWorkUpdate } from "./work-tools";
import { issueSession, recordBeacon } from "./session";

export interface DispatchResult {
  body: unknown;
  isError?: boolean;
}

export async function dispatchTool(
  claims: KmClaims,
  cfg: Config,
  tool: string,
  // Validated upstream: zod schemas on the MCP door, documented contract on
  // /v1. Typed per-tool at each call below.
  args: any,
  headSha: () => string | null,
): Promise<DispatchResult> {
  const fail = (err: unknown): DispatchResult => ({
    body: { error: String((err as Error)?.message ?? err) },
    isError: true,
  });

  switch (tool) {
    case "km_search": {
      const sessionId = await issueSession(claims);
      const res = await tools.kmSearch(claims, args, embedderFor(cfg));
      await recordEvent(claims, sessionId, "search", {
        args_hash: argsHash(args),
        hits: res.hits.length,
      });
      return { body: res };
    }
    case "km_read": {
      const sessionId = await issueSession(claims);
      const res = await tools.kmRead(claims, args);
      await recordEvent(claims, sessionId, "read", {
        args_hash: argsHash(args),
        found: res.page !== null,
      });
      return { body: res.page ?? { error: "not_found", path: args.path } };
    }
    case "km_list":
      return { body: await tools.kmList(claims) };
    case "km_status": {
      const sessionId = await issueSession(claims);
      if (args.skill) await recordBeacon(claims, sessionId, args.skill);
      const res = await tools.kmStatus(claims, {
        sessionId,
        trustMode: cfg.trustMode,
        headSha: headSha(),
        skill: args.skill,
      });
      // Session heartbeat = detection point (pull-only insights).
      await runEventDetectors(claims.org);
      return { body: res };
    }
    case "km_append": {
      const sessionId = await issueSession(claims);
      try {
        const res = await kmAppend(claims, args, { cfg, sessionId });
        await recordEvent(claims, sessionId, "append", {
          args_hash: argsHash(args),
          classification: args.classification ?? "project",
          status: String((res as Record<string, unknown>).status ?? "drafted"),
        });
        return { body: res };
      } catch (err) {
        return fail(err);
      }
    }
    case "km_review": {
      const sessionId = await issueSession(claims);
      try {
        const res = await kmReview(claims, args, { cfg, sessionId });
        await recordEvent(claims, sessionId, "review", {
          action: args.action,
          verdict: args.verdict ?? "",
        });
        return { body: res };
      } catch (err) {
        return fail(err);
      }
    }
    case "km_graph":
      return { body: await tools.kmGraph(claims, args) };
    case "km_chat": {
      const sessionId = await issueSession(claims);
      try {
        const res = await tools.kmChat(claims, args, embedderFor(cfg));
        await recordEvent(claims, sessionId, "chat", {
          args_hash: argsHash(args),
          mode: res.mode,
          hits: res.evidence.length,
        });
        return { body: res };
      } catch (err) {
        return fail(err);
      }
    }
    case "km_projects":
      return { body: await kmProjects(claims, { cfg }) };
    case "km_project_add":
      try {
        return { body: await kmProjectAdd(claims, args, { cfg }) };
      } catch (err) {
        return fail(err);
      }
    case "km_reindex":
      try {
        return { body: await kmReindex(claims, args, { cfg }) };
      } catch (err) {
        return fail(err);
      }
    case "km_invite":
      try {
        return { body: await kmInvite(claims, args) };
      } catch (err) {
        return fail(err);
      }
    case "km_work_current":
      return { body: await kmWorkCurrent(claims, args, cfg) };
    case "km_work_update": {
      const sessionId = await issueSession(claims);
      try {
        const res = await kmWorkUpdate(claims, args, { sessionId });
        await recordEvent(claims, sessionId, "checkpoint", { args_hash: argsHash(args) });
        return { body: res };
      } catch (err) {
        return fail(err);
      }
    }
    case "km_handoff_save": {
      const sessionId = await issueSession(claims);
      try {
        const res = await kmHandoffSave(claims, args, { sessionId });
        await recordEvent(claims, sessionId, "handoff_save", { args_hash: argsHash(args) });
        return { body: res };
      } catch (err) {
        return fail(err);
      }
    }
    case "km_handoff_load": {
      try {
        const res = await kmHandoffLoad(claims, args);
        if (args.claim) {
          const sessionId = await issueSession(claims);
          await recordEvent(claims, sessionId, "handoff_claim", {
            acquired: Boolean((res.claim as Record<string, unknown> | null)?.acquired),
          });
        }
        return { body: res };
      } catch (err) {
        return fail(err);
      }
    }
    case "km_insights":
      try {
        return { body: await kmInsights(claims, args) };
      } catch (err) {
        return fail(err);
      }
    default:
      return { body: { error: `unknown tool: ${tool}` }, isError: true };
  }
}
