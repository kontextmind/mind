/**
 * App factory — separated from index.ts so tests can boot the server
 * in-process against a disposable database.
 */
import { DEMO_NAMESPACE, DEMO_ORG, DEMO_REPO, type Config } from "./config";
import { adminDb, hasDb } from "./db";
import { authenticate } from "./auth";
import { handleMcp } from "./mcp";
import { handleGitHubWebhook } from "./webhook";
import {
  authorizationServerMetadata,
  authorize,
  protectedResourceMetadata,
  registerClient,
  token,
} from "./auth-server";
import { githubCallback, startGitHubLogin } from "./owner-auth";
import { deviceApprove, deviceAuthorization, deviceDeny, devicePage } from "./device-grant";
import { ingestRepo } from "./indexer/ingest";
import { headSha, isRepo } from "./indexer/git";

export async function bootDemo(cfg: Config): Promise<void> {
  if (!hasDb() || !cfg.mindPath) return;
  const sql = adminDb();
  await sql`insert into orgs (id, slug, name, trust_mode) values
    (${DEMO_ORG}, 'demo', 'KontextMind Demo', 'standard')
    on conflict (id) do nothing`;
  await sql`insert into namespaces (id, org_id, slug, kind) values
    (${DEMO_NAMESPACE}, ${DEMO_ORG}, 'demo', 'project')
    on conflict (id) do nothing`;
  await sql`insert into repos (id, org_id, github_full, default_namespace_id) values
    (${DEMO_REPO}, ${DEMO_ORG}, 'local/demo-mind', ${DEMO_NAMESPACE})
    on conflict (id) do update set default_namespace_id = excluded.default_namespace_id`;

  if (!isRepo(cfg.mindPath)) {
    console.warn(`KM_MIND_PATH=${cfg.mindPath} is not a git repo — skipping ingest`);
    return;
  }
  const stats = await ingestRepo(sql, {
    repoId: DEMO_REPO,
    namespaceId: DEMO_NAMESPACE,
    repoPath: cfg.mindPath,
  });
  console.log(
    `indexed ${stats.pages} pages (${stats.chunks} chunks, ${stats.skipped} cached) @ ${stats.headSha.slice(0, 7)}`,
  );
}

export function createFetch(cfg: Config): (req: Request) => Response | Promise<Response> {
  let cachedHead: string | null = null;
  const currentHead = (): string | null => {
    if (!cfg.mindPath) return cachedHead;
    try {
      cachedHead = headSha(cfg.mindPath);
    } catch {
      /* keep last known */
    }
    return cachedHead;
  };

  return async (req) => {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        service: "kontextmind",
        version: "0.1.0",
        mode: cfg.mode,
        database: hasDb() ? "configured" : "absent (degraded: healthz only)",
      });
    }

    if (url.pathname === "/webhooks/github") {
      return handleGitHubWebhook(req, cfg);
    }

    if (url.pathname === "/.well-known/oauth-protected-resource") {
      if (cfg.mode !== "hosted") {
        return Response.json(
          { error: "not_implemented", detail: "OAuth discovery is hosted-mode only" },
          { status: 501 },
        );
      }
      return protectedResourceMetadata(cfg);
    }

    if (cfg.mode === "hosted") {
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return authorizationServerMetadata(cfg);
      }
      if (url.pathname === "/register" && req.method === "POST") {
        return registerClient(req, cfg);
      }
      if (url.pathname === "/authorize" && req.method === "GET") {
        return authorize(req, cfg);
      }
      if (url.pathname === "/token" && req.method === "POST") {
        return token(req, cfg);
      }
      if (url.pathname === "/auth/github/start" && req.method === "GET") {
        return startGitHubLogin(cfg, req);
      }
      if (url.pathname === "/auth/github/callback" && req.method === "GET") {
        return githubCallback(cfg, req);
      }
      if (url.pathname === "/device_authorization" && req.method === "POST") {
        return deviceAuthorization(cfg, req);
      }
      if (url.pathname === "/device" && req.method === "GET") {
        return devicePage(cfg, req);
      }
      if (url.pathname === "/device/approve" && req.method === "POST") {
        return deviceApprove(cfg, req);
      }
      if (url.pathname === "/device/deny" && req.method === "POST") {
        return deviceDeny(cfg, req);
      }
    } else if (url.pathname.startsWith("/.well-known/")) {
      return Response.json(
        { error: "not_implemented", detail: "OAuth discovery is hosted-mode only" },
        { status: 501 },
      );
    }

    if (url.pathname === "/mcp") {
      if (!hasDb()) {
        return Response.json(
          { error: "degraded", detail: "DATABASE_URL not set; MCP unavailable" },
          { status: 503 },
        );
      }
      const authn = await authenticate(cfg, req);
      if (!authn.ok) {
        return Response.json(authn.body, { status: authn.status, headers: authn.headers });
      }
      return handleMcp(req, { cfg, claims: authn.claims, headSha: currentHead });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  };
}
