/**
 * Tracker read-through for km_work_current (docs/protocol.md): tasks read
 * through to the existing tracker, CACHED — KontextMind is not a tracker and
 * never becomes one.
 *
 * Honesty contract: without KM_GITHUB_API_TOKEN the response says
 * connected:false. Faked tracker state would violate evidence-over-self-report.
 * GitHub API base is injectable (KM_GITHUB_API) — GHE + hermetic tests.
 */
import type { Config } from "./config";
import type { KmClaims } from "./db";

export const TRACKER_CACHE_TTL_MS = 60_000;
const MAX_ISSUES = 10;

export interface TrackerIssue {
  ref: string;
  title: string;
  url: string;
  state: string;
  updated_at: string;
}

export interface TrackerReadthrough {
  connected: boolean;
  source?: "github";
  issues?: TrackerIssue[];
  note?: string;
}

interface CacheEntry {
  at: number;
  data: TrackerReadthrough;
}

/** Org-scoped cache: single-instance assumption (B6), 60s TTL. */
const cache = new Map<string, CacheEntry>();

export function clearTrackerCache(): void {
  cache.clear();
}

export async function trackerReadthrough(
  cfg: Config,
  claims: KmClaims,
  now = Date.now(),
): Promise<TrackerReadthrough> {
  const token = cfg.githubApiToken;
  if (!token) {
    return { connected: false, note: "set KM_GITHUB_API_TOKEN for GitHub read-through" };
  }
  const hit = cache.get(claims.org);
  if (hit && now - hit.at < TRACKER_CACHE_TTL_MS) return hit.data;

  let data: TrackerReadthrough;
  try {
    data = await fetchGitHubIssues(cfg, token);
  } catch (err) {
    // Read-through is best-effort: km_work_current must still serve
    // checkpoints/handoffs when the tracker is down.
    data = { connected: true, source: "github", issues: [], note: `fetch failed: ${(err as Error)?.message ?? err}` };
  }
  cache.set(claims.org, { at: now, data });
  return data;
}

async function fetchGitHubIssues(cfg: Config, token: string): Promise<TrackerReadthrough> {
  const api = cfg.githubApi;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
  };
  const userRes = await fetch(`${api}/user`, { headers });
  if (!userRes.ok) throw new Error(`user lookup ${userRes.status}`);
  const user = (await userRes.json()) as { login?: string };
  if (!user.login) throw new Error("user lookup returned no login");

  const q = encodeURIComponent(`assignee:${user.login} state:open`);
  const searchRes = await fetch(
    `${api}/search/issues?q=${q}&sort=updated&order=desc&per_page=${MAX_ISSUES}`,
    { headers },
  );
  if (!searchRes.ok) throw new Error(`issue search ${searchRes.status}`);
  const search = (await searchRes.json()) as {
    items?: Array<{
      number: number;
      title: string;
      html_url: string;
      state: string;
      updated_at: string;
      repository_url?: string;
    }>;
  };
  const issues: TrackerIssue[] = (search.items ?? []).map((i) => ({
    // repo-qualified ref joins cleanly to task_ref in checkpoints/handoffs
    ref: `github:${(i.repository_url ?? "").split("/").slice(-2).join("/") || "repo"}#${i.number}`,
    title: i.title,
    url: i.html_url,
    state: i.state,
    updated_at: i.updated_at,
  }));
  return { connected: true, source: "github", issues };
}
