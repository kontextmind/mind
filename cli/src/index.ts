#!/usr/bin/env bun
/**
 * kontext — the full KontextMind surface, CLI-first (decision 0002:
 * Commander framework).
 *
 * Board stance: the CLI does EVERYTHING; the MCP server wraps the same
 * dispatch (server/src/tool-dispatch.ts). Commands hit the native
 * POST /v1/call transport: one authenticated round-trip, no handshake —
 * that's the speed the CLI exists for. Agents without a shell use MCP;
 * humans, scripts, and shell-capable agents use this.
 *
 * Token precedence: KM_TOKEN env > stored OAuth tokens (kontext login,
 * auto-refreshed) > demo default.
 */
import { Command, Option } from "commander";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { initProject, writeSessionFile, CLI_VERSION } from "./init";
import { doctor, latestRelease, renderReport, serverVersion, updateNotice } from "./doctor";
import { getAuth, login } from "./login";

const DEFAULT_URL = "http://127.0.0.1:13013/mcp";

interface GlobalOpts {
  url?: string;
}

function globalUrl(): string | undefined {
  return (program.opts() as GlobalOpts).url;
}

function resolveUrl(opts: GlobalOpts): string {
  return opts.url ?? globalUrl() ?? process.env.KM_URL ?? DEFAULT_URL;
}

/** One round-trip against the native transport. */
async function apiCall(opts: GlobalOpts, tool: string, args: Record<string, unknown> = {}): Promise<any> {
  const url = resolveUrl(opts);
  const token = (await getAuth(url)) ?? "km-demo-local";
  const res = await fetch(`${url.replace(/\/mcp\/?$/, "")}/v1/call`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  if (res.status === 401) return fail("unauthorized (check KM_TOKEN or run `kontext login`)");
  if (res.status === 429) return fail("rate limited — honor Retry-After");
  const body = (await res.json().catch(() => null)) as { ok: boolean; result: any } | null;
  if (!res.ok || !body?.ok) {
    return fail(String(body?.result?.error ?? `request failed (${res.status})`));
  }
  return body.result;
}

function print(result: unknown): void {
  console.log(JSON.stringify(result, null, 2));
}

function fail(msg: string): never {
  console.error(`kontext: ${msg}`);
  process.exit(1);
}

function int(v: string): number {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) fail(`expected a number, got: ${v}`);
  return n;
}

const program = new Command();
program
  .name("kontext")
  .description("KontextMind CLI — the full surface; the MCP server wraps the same dispatch")
  .version(CLI_VERSION, "-V, --version", "print the CLI version")
  .addOption(new Option("--url <url>", "MCP endpoint base").env("KM_URL"));

// ---------------------------------------------------------------- read

program
  .command("search")
  .description("search the mind (provenance + staleness per hit)")
  .argument("<query...>", "the question")
  .option("--limit <n>", "max hits", int)
  .action(async (queryParts: string[], opts: GlobalOpts & { limit?: number }) => {
    const parsed = await apiCall(opts, "km_search", {
      query: queryParts.join(" "),
      limit: opts.limit,
    });
    for (const hit of parsed.hits ?? []) {
      const flags = [
        hit.status !== "verified" ? hit.status : null,
        hit.superseded_by ? `SUPERSEDED by ${hit.superseded_by}` : null,
        hit.index_stale ? "index-stale" : null,
      ]
        .filter(Boolean)
        .join(", ");
      console.log(`\n${hit.path}  [${hit.commit_sha.slice(0, 7)}${flags ? ` — ${flags}` : ""}]`);
      if (hit.heading) console.log(`  § ${hit.heading}`);
      console.log(`  ${hit.excerpt.replace(/\n+/g, " ").slice(0, 220)}…`);
    }
    if (!(parsed.hits ?? []).length) console.log("no hits");
    console.log(`\n(indexed @ ${parsed.indexed_sha?.slice(0, 7) ?? "?"})`);
  });

program
  .command("read")
  .description("read one mind page")
  .argument("<path>", "page path")
  .action(async (path: string, opts: GlobalOpts) => {
    const page = await apiCall(opts, "km_read", { path });
    if (page.error) return fail(`not found: ${path}`);
    console.log(`# ${page.title ?? page.path}`);
    console.log(`status: ${page.status} · commit ${page.commit_sha.slice(0, 7)} · indexed ${page.indexed_at}`);
    console.log(`\n${page.body}`);
  });

program
  .command("list")
  .description("list all pages (status, path, title)")
  .action(async (opts: GlobalOpts) => {
    const parsed = await apiCall(opts, "km_list");
    for (const p of parsed.pages ?? []) {
      console.log(`${p.status.padEnd(9)} ${p.path}${p.title ? ` — ${p.title}` : ""}`);
    }
  });

program
  .command("graph")
  .description("wikilink neighborhood for a page")
  .argument("<path>", "page path")
  .option("--depth <n>", "1–2", int)
  .action(async (path: string, opts: GlobalOpts & { depth?: number }) => {
    print(await apiCall(opts, "km_graph", { path, depth: opts.depth }));
  });

program
  .command("chat")
  .description("evidence pack (synthesis stays client-side)")
  .argument("<question...>", "the question")
  .option("--deep", "one hop of graph expansion")
  .option("--limit <n>", "max evidence items", int)
  .action(async (qParts: string[], opts: GlobalOpts & { deep?: boolean; limit?: number }) => {
    print(
      await apiCall(opts, "km_chat", {
        question: qParts.join(" "),
        mode: opts.deep ? "deep" : undefined,
        limit: opts.limit,
      }),
    );
  });

program
  .command("status")
  .description("index freshness + session; writes .kontextmind/session in a git work tree")
  .option("--skill <name>", "beacon handshake skill")
  .action(async (opts: GlobalOpts & { skill?: string }) => {
    const parsed = await apiCall(opts, "km_status", { skill: opts.skill });
    console.log(JSON.stringify(parsed, null, 2));
    if (parsed.session_id && writeSessionFile(process.cwd(), parsed.session_id)) {
      console.log(`\n(session written to .kontextmind/session — the commit-msg hook will attach it)`);
    }
  });

// ---------------------------------------------------------------- write

program
  .command("append")
  .description("file a learning draft (secret-gated)")
  .requiredOption("--title <title>", "draft title")
  .requiredOption("--content <content>", "draft body")
  .option("--org", "org classification (default: project)")
  .option("--supersedes <path>", "page this replaces")
  .action(async (opts: GlobalOpts & { title: string; content: string; org?: boolean; supersedes?: string }) => {
    print(
      await apiCall(opts, "km_append", {
        title: opts.title,
        content: opts.content,
        classification: opts.org ? "org" : undefined,
        supersedes: opts.supersedes,
      }),
    );
  });

const review = program.command("review").description("work the review queue");
review
  .command("list", { isDefault: true })
  .description("pending items first")
  .option("--kind <kind>", "filter by kind")
  .action(async (opts: GlobalOpts & { kind?: string }) => {
    const parsed = await apiCall(opts, "km_review", { action: "list", kind: opts.kind });
    for (const item of parsed.items ?? []) {
      const state = item.resolved_at ? `[${item.verdict}]` : "[pending]";
      console.log(`${state} ${item.kind.padEnd(10)} ${item.id}  ${item.title}`);
    }
    if (!(parsed.items ?? []).length) console.log("queue empty");
  });
review
  .command("resolve")
  .description("resolve one item")
  .argument("<id>", "review item id")
  .argument("<verdict>", "promote|research|skip")
  .option("--reason <reason>", "required for research/skip")
  .action(async (id: string, verdict: string, opts: GlobalOpts & { reason?: string }) => {
    print(await apiCall(opts, "km_review", { action: "resolve", id, verdict, reason: opts.reason }));
  });

// ------------------------------------------------------------- projects

program
  .command("projects")
  .description("list projects (mind repos) with freshness")
  .action(async (opts: GlobalOpts) => print(await apiCall(opts, "km_projects")));

program
  .command("project-add")
  .description("register a project (steward/owner)")
  .argument("<name>", "project name")
  .option("--path <path>", "local git repo to index now")
  .option("--github <full>", "github owner/repo")
  .action(async (name: string, opts: GlobalOpts & { path?: string; github?: string }) => {
    print(await apiCall(opts, "km_project_add", { name, path: opts.path, github_full: opts.github }));
  });

program
  .command("reindex")
  .description("reconcile the index against git HEAD")
  .option("--project <id>", "project id or github_full")
  .action(async (opts: GlobalOpts & { project?: string }) => {
    print(await apiCall(opts, "km_reindex", { project: opts.project }));
  });

program
  .command("invite")
  .description("invite a member (steward/owner)")
  .argument("<email>", "invitee email")
  .option("--role <role>", "member|steward|owner")
  .action(async (email: string, opts: GlobalOpts & { role?: string }) => {
    print(await apiCall(opts, "km_invite", { email, role: opts.role }));
  });

// -------------------------------------------------------- intelligence

const insights = program.command("insights").description("workflow-intelligence insights (pull-only)");
insights
  .command("list", { isDefault: true })
  .description("≤3 pending insights")
  .option("--kind <kind>", "routing|loop|drift|contradiction|gap|process")
  .option("--namespace <ns>", "namespace filter")
  .action(async (opts: GlobalOpts & { kind?: string; namespace?: string }) => {
    print(await apiCall(opts, "km_insights", { kind: opts.kind, namespace: opts.namespace }));
  });
insights
  .command("dismiss")
  .description("dismiss with a verdict (reason required for dismissed/snoozed)")
  .argument("<id>", "insight id")
  .argument("<verdict>", "accepted|dismissed|snoozed")
  .option("--reason <reason>", "why")
  .action(async (id: string, verdict: string, opts: GlobalOpts & { reason?: string }) => {
    print(await apiCall(opts, "km_insights", { action: "dismiss", id, verdict, reason: opts.reason }));
  });

// ---------------------------------------------------------- work context

program
  .command("work")
  .description("current work context: checkpoints, open handoffs, trackers")
  .option("--namespace <ns>", "namespace filter")
  .action(async (opts: GlobalOpts & { namespace?: string }) => {
    print(await apiCall(opts, "km_work_current", { namespace: opts.namespace }));
  });

program
  .command("checkpoint")
  .description("file a work checkpoint (secret-scanned, ~90d TTL)")
  .requiredOption("--note <note>", "what happened")
  .option("--task <ref>", "task ref (Linear/GitHub id or free text)")
  .option("--status <status>", "task status update")
  .action(async (opts: GlobalOpts & { note: string; task?: string; status?: string }) => {
    print(await apiCall(opts, "km_work_update", { note: opts.note, task_ref: opts.task, status: opts.status }));
  });

const handoff = program.command("handoff").description("claimable handoffs");
handoff
  .command("save")
  .description("save a handoff for the next agent/session")
  .requiredOption("--state <json>", "bounded state JSON")
  .option("--task <ref>", "task ref")
  .option("--steps <steps>", "next steps, ';'-separated")
  .option("--idempotency-key <key>", "retry-safe key")
  .action(
    async (opts: GlobalOpts & { state: string; task?: string; steps?: string; idempotencyKey?: string }) => {
      let state: Record<string, unknown>;
      try {
        state = JSON.parse(opts.state);
      } catch {
        return fail("--state must be valid JSON");
      }
      print(
        await apiCall(opts, "km_handoff_save", {
          state,
          task_ref: opts.task,
          next_steps: opts.steps?.split(";").map((s) => s.trim()).filter(Boolean),
          idempotency_key: opts.idempotencyKey,
        }),
      );
    },
  );
handoff
  .command("load")
  .description("load a handoff; --claim acquires the lease")
  .argument("<id>", "handoff id")
  .option("--claim", "acquire the claim lease")
  .action(async (id: string, opts: GlobalOpts & { claim?: boolean }) => {
    print(await apiCall(opts, "km_handoff_load", { id, claim: opts.claim || undefined }));
  });

// ------------------------------------------------------------------ ops

program
  .command("login")
  .description("OAuth login via device code (approve in your browser)")
  .action(async (opts: GlobalOpts) => {
    try {
      await login(resolveUrl(opts));
    } catch (err) {
      fail(`kontext login: ${(err as Error).message}`);
    }
  });

program
  .command("init")
  .description("connect this project: MCP config + trailer hook + AGENTS.md contract")
  .option("--dir <dir>", "project directory (default: cwd)")
  .option("--token <token>", "bearer token (demo mode)")
  .action(async (opts: GlobalOpts & { dir?: string; token?: string }) => {
    const target = opts.dir ?? process.cwd();
    try {
      const report = initProject({
        projectDir: target,
        url: resolveUrl(opts),
        token: opts.token ?? process.env.KM_TOKEN ?? "km-demo-local",
      });
      console.log(`kontext init — ${target}`);
      console.log(`  .mcp.json         ${report.mcp}`);
      console.log(
        `  commit-msg hook   ${report.hook}${report.hook === "skipped-existing" ? " (foreign hook kept; agents emit the trailer directly)" : ""}`,
      );
      console.log(`  AGENTS.md         ${report.agents}`);
      console.log(`  manifest          ${report.manifest}`);
      console.log(`  .gitignore        ${report.gitignore}`);
    } catch (err) {
      fail(`kontext init: ${(err as Error).message}`);
    }
  });

program
  .command("doctor")
  .description("verify the installation + check for new releases")
  .option("--dir <dir>", "project directory (default: cwd)")
  .action(async (opts: GlobalOpts & { dir?: string }) => {
    const target = opts.dir ?? process.cwd();
    const manifest = readManifestSafe(join(target, ".kontextmind", "kontext.json"));
    const checkUrl = resolveUrl(opts) ?? manifest?.url;
    const sv = await serverVersion(checkUrl);
    const report = doctor(target, {
      cliVersion: CLI_VERSION,
      serverVersion: sv,
      sessionActive: isFile(join(target, ".kontextmind", "session")),
    });
    const latest = await latestRelease(CLI_VERSION);
    const notice = latest ? updateNotice(CLI_VERSION, latest) : null;
    console.log(renderReport(report, notice));
    if (report.broken) process.exitCode = 1;
  });

program
  .command("version")
  .description("CLI version + release notice")
  .action(async () => {
    console.log(`kontext ${CLI_VERSION}`);
    const latest = await latestRelease(CLI_VERSION);
    const notice = latest ? updateNotice(CLI_VERSION, latest) : null;
    if (notice) console.error(notice);
  });

// -------------------------------------------------------------- helpers

function readManifestSafe(p: string): { url?: string } | null {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

program.parseAsync(process.argv).catch((err) => {
  fail(String((err as Error)?.message ?? err));
});
