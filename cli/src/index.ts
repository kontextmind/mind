#!/usr/bin/env bun
/**
 * kontext — CLI surface.
 * search/read/status are THIN MCP-HTTP clients: they exercise the exact same
 * protocol path an MCP client would. A passing wrapper demo with a broken MCP
 * path is impossible by construction.
 * `init` connects a project: MCP config + commit-msg trailer hook + AGENTS.md
 * contract (docs/session-spine.md).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { initProject, writeSessionFile } from "./init";
import { getAuth, login } from "./login";

const url = process.env.KM_URL ?? "http://127.0.0.1:3000/mcp";

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  // Precedence: KM_TOKEN env > stored OAuth tokens (auto-refreshed) > demo
  // default. `kontext login` populates the store via the device grant.
  const token = (await getAuth(url)) ?? process.env.KM_TOKEN ?? "km-demo-local";
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "kontext-cli", version: "0.1.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function toolText(res: { content?: Array<{ type: string; text?: string }> }): string {
  return (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

const [, , cmd, ...rest] = process.argv;

async function main() {
  switch (cmd) {
    case "search": {
      const query = rest.join(" ");
      if (!query) return fail("usage: kontext search <query>");
      await withClient(async (c) => {
        const res = await c.callTool({ name: "km_search", arguments: { query } });
        const parsed = JSON.parse(toolText(res as never));
        for (const hit of parsed.hits ?? []) {
          const flags = [
            hit.status !== "verified" ? hit.status : null,
            hit.superseded_by ? `SUPERSEDED by ${hit.superseded_by}` : null,
            hit.index_stale ? "index-stale" : null,
          ].filter(Boolean).join(", ");
          console.log(`\n${hit.path}  [${hit.commit_sha.slice(0, 7)}${flags ? ` — ${flags}` : ""}]`);
          if (hit.heading) console.log(`  § ${hit.heading}`);
          console.log(`  ${hit.excerpt.replace(/\n+/g, " ").slice(0, 220)}…`);
        }
        if (!(parsed.hits ?? []).length) console.log("no hits");
        console.log(`\n(indexed @ ${parsed.indexed_sha?.slice(0, 7) ?? "?"})`);
      });
      return;
    }
    case "read": {
      const path = rest[0];
      if (!path) return fail("usage: kontext read <path>");
      await withClient(async (c) => {
        const res = await c.callTool({ name: "km_read", arguments: { path } });
        const parsed = JSON.parse(toolText(res as never));
        if (!parsed.page) return fail(`not found: ${path}`);
        console.log(`# ${parsed.page.title ?? parsed.page.path}`);
        console.log(`status: ${parsed.page.status} · commit ${parsed.page.commit_sha.slice(0, 7)} · indexed ${parsed.page.indexed_at}`);
        console.log(`\n${parsed.page.body}`);
      });
      return;
    }
    case "status": {
      await withClient(async (c) => {
        const res = await c.callTool({ name: "km_status", arguments: {} });
        const text = toolText(res as never);
        console.log(text);
        // MCP handshake writes the active session file the commit-msg hook
        // reads (docs/session-spine.md) — only inside a git work tree.
        try {
          const sessionId = (JSON.parse(text) as { session_id?: string }).session_id;
          if (sessionId && writeSessionFile(process.cwd(), sessionId)) {
            console.log(`\n(session written to .kontextmind/session — the commit-msg hook will attach it)`);
          }
        } catch {
          /* status output that is not JSON still prints above */
        }
      });
      return;
    }
    case "login": {
      // usage: kontext login [--url U] — device-grant OAuth (RFC 8628)
      try {
        await login(argAfter("--url") ?? url);
      } catch (err) {
        return fail(`kontext login: ${(err as Error).message}`);
      }
      return;
    }
    case "init": {
      // usage: kontext init [--url U] [--token T] [--dir D]
      const target = argAfter("--dir") ?? process.cwd();
      try {
        const report = initProject({
          projectDir: target,
          url: argAfter("--url") ?? url,
          token: argAfter("--token") ?? process.env.KM_TOKEN ?? "km-demo-local",
        });
        console.log(`kontext init — ${target}`);
        console.log(`  .mcp.json         ${report.mcp}`);
        console.log(`  commit-msg hook   ${report.hook}${report.hook === "skipped-existing" ? " (foreign hook kept; agents emit the trailer directly)" : ""}`);
        console.log(`  AGENTS.md         ${report.agents}`);
        console.log(`  manifest          ${report.manifest}`);
        console.log(`  .gitignore        ${report.gitignore}`);
      } catch (err) {
        return fail(`kontext init: ${(err as Error).message}`);
      }
      return;
    }
    case "append": {
      // usage: kontext append --title "..." --content "..." [--org] [--supersedes path]
      const title = argAfter("--title");
      const content = argAfter("--content");
      if (!title || !content) {
        return fail('usage: kontext append --title "..." --content "..." [--org] [--supersedes path]');
      }
      await withClient(async (c) => {
        const res = await c.callTool({
          name: "km_append",
          arguments: {
            title,
            content,
            classification: rest.includes("--org") ? "org" : "project",
            supersedes: argAfter("--supersedes"),
          },
        });
        console.log(toolText(res as never));
      });
      return;
    }
    case "review": {
      // usage: kontext review [list [--kind k]] | [resolve <id> <promote|research|skip> [--reason "..."]]
      await withClient(async (c) => {
        if (rest[0] === "resolve") {
          const [, id, verdict] = rest;
          if (!id || !verdict) return fail("usage: kontext review resolve <id> <promote|research|skip> [--reason \"...\"]");
          const res = await c.callTool({
            name: "km_review",
            arguments: { action: "resolve", id, verdict, reason: argAfter("--reason") },
          });
          console.log(toolText(res as never));
          return;
        }
        const res = await c.callTool({
          name: "km_review",
          arguments: { action: "list", kind: argAfter("--kind") },
        });
        const parsed = JSON.parse(toolText(res as never));
        for (const item of parsed.items ?? []) {
          const state = item.resolved_at ? `[${item.verdict}]` : "[pending]";
          console.log(`${state} ${item.kind.padEnd(10)} ${item.id}  ${item.title}`);
        }
        if (!(parsed.items ?? []).length) console.log("queue empty");
      });
      return;
    }
    default:
      console.log(`kontext — KontextMind

usage:
  kontext login [--url U]                   OAuth login (device code — approve in browser)
  kontext init [--url U] [--token T] [--dir D]  connect this project (MCP config +
                                                commit-msg trailer hook + AGENTS.md)
  kontext search <query>                    search the mind (provenance + staleness per hit)
  kontext read <path>                       read one page
  kontext status                            indexed SHA vs HEAD, trust mode, session
                                            (writes .kontextmind/session for the hook)
  kontext append --title T --content C      file a learning draft (secret-gated)
  kontext review [list|resolve ...]         work the review queue

env:
  KM_URL    MCP endpoint   (default http://127.0.0.1:3000/mcp)
  KM_TOKEN  bearer token   (default km-demo-local)`);
  }
}

function argAfter(flag: string): string | undefined {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

main().catch((err) => {
  console.error(`kontext: ${err?.message ?? err}`);
  process.exit(1);
});
