/**
 * The dashboard — Workflow Intelligence made visible.
 *
 * Law (README principle 5): every panel answers "what decision does this
 * change?" Panels without a decision are not built. All data comes from the
 * evidence spine (git_evidence, km_event, km_sessions, insights) — never
 * self-report.
 *
 * Server-rendered HTML, no framework. Read lane: admin connection
 * (operational metrics, same lane as webhook ingestion). Verdicts go through
 * the standard dispatch (claims-bound, like every other mutation).
 *
 * Auth: bearer token as elsewhere. HTML forms cannot set Authorization
 * headers, so dismiss accepts the token as a hidden field too — fine for
 * demo-tier single tokens; hosted OAuth users use the CLI/API for verdicts.
 */
import { authenticate } from "./auth";
import type { Config } from "./config";
import { adminDb, hasDb } from "./db";
import { dispatchTool } from "./tool-dispatch";

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

interface Panel {
  title: string;
  decision: string;
  body: string;
}

function panel(p: Panel): string {
  return `<section class="panel">
    <h2>${esc(p.title)}</h2>
    <p class="decision">Decision it drives: <em>${esc(p.decision)}</em></p>
    ${p.body}
  </section>`;
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return `<p class="empty">nothing yet — evidence accumulates as agents commit</p>`;
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

async function renderDashboard(token: string): Promise<string> {
  const sql = adminDb();
  const panels: Panel[] = [];

  // 1. Trailer coverage
  const cov = await sql`select
    (select count(distinct sha) from git_evidence) as resolved,
    (select count(*) from km_unresolved_trailers) as unresolved`;
  const resolved = Number(cov[0].resolved ?? 0);
  const unresolved = Number(cov[0].unresolved ?? 0);
  const observed = resolved + unresolved;
  const pct = observed > 0 ? Math.round((resolved / observed) * 100) : null;
  panels.push({
    title: "Trailer coverage",
    decision:
      pct === null
        ? "no trailers observed yet — wire agents with `kontext init`"
        : pct < 90
          ? "below 90% — find the harnesses committing without trailers and fix their emitters"
          : "healthy — instrumentation is complete",
    body: `<p class="big">${pct === null ? "—" : `${pct}%`}</p>
      <p>${resolved} attributed commit${resolved === 1 ? "" : "s"} · ${unresolved} unresolvable trailer${unresolved === 1 ? "" : "s"}</p>`,
  });

  // 2. Sessions (7 days)
  const sessions = await sql`select s.id, s.principal, s.started_at,
      (select count(*) from km_event e where e.session_id = s.id) as events
    from km_sessions s
    where s.started_at > now() - interval '7 days'
    order by s.started_at desc limit 20`;
  panels.push({
    title: "Active sessions (7d)",
    decision: "a session with zero events is an instrumentation break, not a quiet agent",
    body: table(
      ["session", "principal", "events", "started"],
      sessions.map((s) => [
        `<code>${esc(String(s.id).slice(0, 18))}…</code>`,
        esc(s.principal),
        Number(s.events) === 0 ? `<strong class="warn">0</strong>` : esc(s.events),
        esc((s.started_at as Date).toISOString().slice(0, 16).replace("T", " ")),
      ]),
    ),
  });

  // 3. Pending insights
  const insights = await sql`select id, kind, title, confidence, created_at
    from insights where verdict = 'pending'
    order by confidence desc, created_at desc limit 10`;
  const insightRows = insights.map((i) => [
    `<code>${esc(i.kind)}</code>`,
    esc(i.title),
    esc(Number(i.confidence).toFixed(2)),
    `<form method="post" action="/dashboard/dismiss" class="inline">
       <input type="hidden" name="token" value="${esc(token)}">
       <input type="hidden" name="id" value="${esc(i.id)}">
       <select name="verdict">
         <option value="accepted">accepted</option>
         <option value="dismissed">dismissed</option>
         <option value="snoozed">snoozed</option>
       </select>
       <input type="text" name="reason" placeholder="reason (required to dismiss/snooze)" size="28">
       <button type="submit">verdict</button>
     </form>`,
  ]);
  panels.push({
    title: "Pending insights",
    decision: "verdicts keep the signal honest — dismissed requires a reason",
    body: table(["kind", "insight", "conf", "verdict"], insightRows),
  });

  // 4. Index freshness
  const repos = await sql`select github_full, head_sha, indexed_at from repos order by github_full`;
  panels.push({
    title: "Index freshness",
    decision: "lag between head and indexed → run `kontext reindex`",
    body: table(
      ["repo", "head", "indexed"],
      repos.map((r) => [
        esc(r.github_full),
        `<code>${esc(String(r.head_sha ?? "—").slice(0, 7))}</code>`,
        r.indexed_at ? esc((r.indexed_at as Date).toISOString().slice(0, 16).replace("T", " ")) : "never",
      ]),
    ),
  });

  // 5. Recent evidence
  const evidence = await sql`select e.sha, e.pr_number, e.ci_status, e.merged_at, s.principal
    from git_evidence e left join km_sessions s on s.id = e.session_id
    order by e.merged_at desc nulls last, e.sha desc limit 10`;
  panels.push({
    title: "Recent evidence",
    decision: "what actually landed, attributed to which session — the ground truth for reviews",
    body: table(
      ["sha", "session", "PR", "CI", "merged"],
      evidence.map((e) => [
        `<code>${esc(String(e.sha).slice(0, 7))}</code>`,
        e.principal ? `<code>${esc(String(e.principal).slice(0, 16))}</code>` : "—",
        e.pr_number ? `#${esc(e.pr_number)}` : "—",
        esc(e.ci_status ?? "—"),
        e.merged_at ? esc((e.merged_at as Date).toISOString().slice(0, 16).replace("T", " ")) : "—",
      ]),
    ),
  });

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>KontextMind — intelligence</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0e1116; color: #dbe2ea;
         max-width: 64em; margin: 2em auto; padding: 0 1em; }
  h1 { font-weight: 600; } h1 small { color: #7d8794; font-weight: 400; }
  .panel { background: #161b22; border: 1px solid #2b3240; border-radius: 10px; padding: 1em 1.2em; margin: 1.2em 0; }
  .panel h2 { margin: 0 0 .2em; font-size: 1.05em; }
  .decision { color: #7d8794; font-size: .85em; margin: 0 0 .8em; }
  .big { font-size: 2em; margin: .2em 0; }
  .empty { color: #7d8794; font-style: italic; }
  .warn { color: #e5a04c; }
  table { border-collapse: collapse; width: 100%; font-size: .9em; }
  th, td { text-align: left; padding: .35em .6em; border-bottom: 1px solid #2b3240; }
  th { color: #7d8794; font-weight: 500; }
  code { background: #0e1116; padding: .1em .35em; border-radius: 4px; font-size: .9em; }
  form.inline { display: flex; gap: .4em; align-items: center; }
  input, select, button { background: #0e1116; color: #dbe2ea; border: 1px solid #2b3240; border-radius: 6px; padding: .25em .5em; }
  button { cursor: pointer; }
  .flash { padding: .6em 1em; border-radius: 8px; margin: 1em 0; }
  .flash.ok { background: #14321f; } .flash.err { background: #3a1518; }
</style></head><body>
<h1>KontextMind <small>— workflow intelligence (evidence only, never self-report)</small></h1>
{{FLASH}}
${panels.map(panel).join("\n")}
<p style="color:#7d8794;font-size:.8em">verdicts also available via <code>kontext insights dismiss &lt;id&gt; &lt;verdict&gt; --reason …</code></p>
</body></html>`;
}

function bearerOf(req: Request): string | null {
  const h = req.headers.get("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

export async function handleDashboard(req: Request, cfg: Config): Promise<Response> {
  if (!hasDb()) {
    return Response.json({ error: "degraded", detail: "DATABASE_URL not set" }, { status: 503 });
  }
  const authn = await authenticate(cfg, req);
  if (!authn.ok) {
    return new Response("unauthorized", { status: authn.status, headers: authn.headers });
  }
  const token = bearerOf(req) ?? "";
  const html = (await renderDashboard(token)).replace("{{FLASH}}", "");
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function handleDashboardDismiss(req: Request, cfg: Config): Promise<Response> {
  if (!hasDb()) {
    return Response.json({ error: "degraded" }, { status: 503 });
  }
  const form = new URLSearchParams(await req.text());
  const token = form.get("token") ?? "";
  // The form's hidden token authenticates exactly like the bearer header.
  const authn = await authenticate(cfg, new Request("http://internal/dismiss", {
    headers: { authorization: `Bearer ${token}` },
  }));
  if (!authn.ok) return new Response("unauthorized", { status: authn.status });

  const { body, isError } = await dispatchTool(
    authn.claims,
    cfg,
    "km_insights",
    {
      action: "dismiss",
      id: form.get("id") ?? "",
      verdict: form.get("verdict") ?? "",
      reason: form.get("reason") ?? "",
    },
    () => null,
  );

  const flash = isError
    ? `<div class="flash err">verdict failed: ${esc((body as Record<string, unknown>)?.error)}</div>`
    : `<div class="flash ok">verdict recorded</div>`;
  const html = (await renderDashboard(token)).replace("{{FLASH}}", flash);
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
