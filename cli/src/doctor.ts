/**
 * kontext doctor — installation health + update notice.
 *
 * Answers "is it installed properly?" and "is there a new release?" with
 * exit codes a script can trust: 0 = healthy (warnings allowed), 1 = broken.
 *
 * Update notice: once per 24h we ask GitHub for the latest release and
 * compare versions. Best-effort: 2s timeout, silent failure, stderr-only,
 * KM_NO_UPDATE_CHECK=1 opts out. A release check must never break a command.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_MARKER, AGENTS_BEGIN } from "./init";
import { configDir } from "./login";

export const RELEASES_URL =
  process.env.KM_RELEASES_URL ??
  "https://api.github.com/repos/kontext-mind/mind/releases/latest";
export const UPDATE_CHECK_INTERVAL_MS = 24 * 3600 * 1000;

export interface CheckItem {
  ok: boolean;
  warn?: boolean;
  label: string;
  detail?: string;
}

/** Semver-lite compare: -1 / 0 / 1. Non-numeric parts compare as equal-ish 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

/** One-line notice when a newer release exists; null otherwise. */
export function updateNotice(current: string, latest: string): string | null {
  if (compareVersions(current, latest) >= 0) return null;
  return (
    `KontextMind ${latest} is out (you are on ${current}). ` +
    `Update with \`npm i -g @kontextmind/cli\` (or git pull in your checkout), ` +
    `then re-run \`kontext init\`.`
  );
}

interface UpdateCache {
  checked_at: number;
  latest: string | null;
}

function cachePath(): string {
  return join(configDir(), "update-check.json");
}

/** Latest release tag, throttled to one network call per day. Never throws. */
export async function latestRelease(
  cliVersion: string,
  now = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (process.env.KM_NO_UPDATE_CHECK === "1") return null;
  try {
    let cached: UpdateCache | null = null;
    if (existsSync(cachePath())) {
      cached = JSON.parse(readFileSync(cachePath(), "utf8")) as UpdateCache;
    }
    if (cached && now - cached.checked_at < UPDATE_CHECK_INTERVAL_MS) {
      return cached.latest;
    }
    const res = await fetchImpl(RELEASES_URL, {
      headers: {
        accept: "application/vnd.github+json",
        // Private repos need a token; public ones work unauthenticated.
        ...(process.env.GITHUB_TOKEN
          ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
      signal: AbortSignal.timeout(2000),
    });
    const latest = res.ok
      ? (((await res.json()) as { tag_name?: string }).tag_name ?? null)
      : null;
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify({ checked_at: now, latest }, null, 2));
    return latest;
  } catch {
    return null; // a release check must never break a command
  }
}

export interface DoctorReport {
  dir: string;
  items: CheckItem[];
  broken: boolean;
}

/** Full installation health check for one project directory. */
export function doctor(
  projectDir: string,
  opts: { cliVersion: string; serverVersion?: string | null; sessionActive?: boolean } = {
    cliVersion: "0.0.0",
  },
): DoctorReport {
  const items: CheckItem[] = [];
  const has = (p: string) => existsSync(join(projectDir, p));

  if (!has(".git")) {
    items.push({ ok: false, label: "git repository", detail: "no .git — kontext needs git (the evidence spine)" });
  } else {
    items.push({ ok: true, label: "git repository" });
  }

  const hookPath = join(projectDir, ".git", "hooks", "commit-msg");
  if (!existsSync(hookPath)) {
    items.push({ ok: false, label: "commit-msg hook", detail: "missing — run `kontext init`" });
  } else {
    const body = readFileSync(hookPath, "utf8");
    if (!body.includes(HOOK_MARKER)) {
      items.push({ ok: true, warn: true, label: "commit-msg hook", detail: "foreign hook present; agents must emit trailers directly" });
    } else if ((statSync(hookPath).mode & 0o111) === 0) {
      items.push({ ok: false, label: "commit-msg hook", detail: "not executable — re-run `kontext init`" });
    } else {
      items.push({ ok: true, label: "commit-msg hook", detail: "kontextmind:trailer-hook v1" });
    }
  }

  if (!has("AGENTS.md") || !readFileSync(join(projectDir, "AGENTS.md"), "utf8").includes(AGENTS_BEGIN)) {
    items.push({ ok: false, label: "AGENTS.md contract", detail: "missing — run `kontext init`" });
  } else {
    items.push({ ok: true, label: "AGENTS.md contract" });
  }

  const manifestPath = join(projectDir, ".kontextmind", "kontext.json");
  if (!existsSync(manifestPath)) {
    items.push({ ok: false, label: "manifest", detail: "missing — run `kontext init`" });
  } else {
    try {
      const m = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        installed_at?: string;
        cli_version?: string;
      };
      const stale =
        m.cli_version && compareVersions(m.cli_version, opts.cliVersion) < 0
          ? `installed with older CLI ${m.cli_version} — re-run \`kontext init\``
          : undefined;
      items.push({
        ok: true,
        warn: Boolean(stale),
        label: "manifest",
        detail: stale ?? `installed ${m.installed_at?.slice(0, 10) ?? "?"}`,
      });
    } catch {
      items.push({ ok: false, label: "manifest", detail: "unparseable — re-run `kontext init`" });
    }
  }

  if (opts.serverVersion !== undefined) {
    if (opts.serverVersion === null) {
      items.push({ ok: true, warn: true, label: "server", detail: "unreachable (commands needing the mind will fail)" });
    } else {
      const drift =
        compareVersions(opts.serverVersion, opts.cliVersion) > 0
          ? `server ${opts.serverVersion} is newer than CLI ${opts.cliVersion} — update the CLI`
          : undefined;
      items.push({ ok: true, warn: Boolean(drift), label: "server", detail: drift ?? `kontextmind v${opts.serverVersion}` });
    }
  }

  if (opts.sessionActive === true) {
    items.push({ ok: true, label: "session", detail: "active (.kontextmind/session present)" });
  } else if (has(".git")) {
    items.push({
      ok: true,
      warn: true,
      label: "session",
      detail: "no active session yet — first km_* call writes it (hook no-ops until then)",
    });
  }

  return { dir: projectDir, items, broken: items.some((i) => !i.ok) };
}

/** Human-readable report; the CLI prints it verbatim. */
export function renderReport(r: DoctorReport, notice: string | null): string {
  const lines = [`kontext doctor — ${r.dir}`];
  for (const i of r.items) {
    const mark = !i.ok ? "✗" : i.warn ? "!" : "✓";
    lines.push(`  ${mark} ${i.label}${i.detail ? ` — ${i.detail}` : ""}`);
  }
  if (notice) lines.push(`  ! update — ${notice}`);
  lines.push(r.broken ? "result: BROKEN — fix the ✗ items above" : "result: healthy");
  return lines.join("\n");
}

/** Ping /healthz for the server's version. Never throws; null = unreachable. */
export async function serverVersion(
  mcpUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const base = mcpUrl.replace(/\/mcp\/?$/, "");
    const res = await fetchImpl(`${base}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return ((await res.json()) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}
