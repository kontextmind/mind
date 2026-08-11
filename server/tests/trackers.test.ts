/**
 * Tracker read-through (docs/protocol.md km_work_current): GitHub issues,
 * cached, honest. Mock GitHub API via the injectable KM_GITHUB_API base —
 * no network, no token needed to run the suite.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import type { KmClaims } from "../src/db";
import { clearTrackerCache, trackerReadthrough, TRACKER_CACHE_TTL_MS } from "../src/trackers";
import type { Config } from "../src/config";

const CLAIMS: KmClaims = {
  sub: "user_demo",
  kind: "human",
  org: "org_tracker_test",
  namespaces: ["ns_tracker"],
  roles: {},
};

describe("tracker read-through (GitHub)", () => {
  let ghApi: ReturnType<typeof Bun.serve>;
  let apiBase: string;
  let upstreamHits: number;

  const cfgOf = (token: string | null): Config => ({
    mode: "hosted",
    port: 0,
    demoToken: "unused",
    trustMode: "standard",
    mindPath: null,
    appPassword: "unused",
    githubWebhookSecret: null,
    publicUrl: "http://km-tracker.test",
    bootstrapEmails: [],
    ownerAuth: "allowlist",
    github: null,
    githubApi: apiBase,
    githubApiToken: token,
    authRateLimit: 10000,
  });

  beforeAll(() => {
    ghApi = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const u = new URL(req.url);
        if (!req.headers.get("authorization")?.startsWith("Bearer ght_")) {
          return Response.json({ message: "Bad credentials" }, { status: 401 });
        }
        if (u.pathname === "/user") {
          return Response.json({ login: "octocat" });
        }
        if (u.pathname === "/search/issues") {
          upstreamHits++;
          expect(u.searchParams.get("q")).toContain("assignee:octocat");
          return Response.json({
            items: [
              {
                number: 42,
                title: "Wire the indexer",
                html_url: "https://github.com/acme/mind/issues/42",
                state: "open",
                updated_at: "2026-08-01T00:00:00Z",
                repository_url: "https://api.github.com/repos/acme/mind",
              },
              {
                number: 7,
                title: "Review queue backlog",
                html_url: "https://github.com/acme/mind/issues/7",
                state: "open",
                updated_at: "2026-07-20T00:00:00Z",
                repository_url: "https://api.github.com/repos/acme/mind",
              },
            ],
          });
        }
        return Response.json({ message: "Not Found" }, { status: 404 });
      },
    });
    apiBase = `http://127.0.0.1:${ghApi.port}`;
  });

  afterAll(() => {
    ghApi?.stop(true);
    clearTrackerCache();
  });

  test("without a token: honest connected:false (never faked)", async () => {
    clearTrackerCache();
    const res = await trackerReadthrough(cfgOf(null), CLAIMS);
    expect(res.connected).toBe(false);
    expect(res.note).toContain("KM_GITHUB_API_TOKEN");
  });

  test("with a token: open assigned issues, repo-qualified refs", async () => {
    clearTrackerCache();
    upstreamHits = 0;
    const res = await trackerReadthrough(cfgOf("ght_mock"), CLAIMS);
    expect(res.connected).toBe(true);
    expect(res.source).toBe("github");
    expect(res.issues?.length).toBe(2);
    expect(res.issues?.[0].ref).toBe("github:acme/mind#42");
    expect(res.issues?.[0].title).toBe("Wire the indexer");
    expect(upstreamHits).toBe(1);
  });

  test("cached: second read within TTL does not hit the tracker again", async () => {
    upstreamHits = 0;
    const cfg = cfgOf("ght_mock"); // cache was filled by the previous test
    const again = await trackerReadthrough(cfg, CLAIMS);
    expect(again.issues?.length).toBe(2);
    expect(upstreamHits).toBe(0);
    // Past the TTL the cache expires and the tracker is consulted again.
    const later = await trackerReadthrough(cfg, CLAIMS, Date.now() + TRACKER_CACHE_TTL_MS + 1);
    expect(later.issues?.length).toBe(2);
    expect(upstreamHits).toBe(1);
    clearTrackerCache();
  });

  test("tracker outage degrades gracefully (read-through never breaks work context)", async () => {
    clearTrackerCache();
    const dead = cfgOf("ght_mock");
    dead.githubApi = "http://127.0.0.1:1"; // nothing listening
    const res = await trackerReadthrough(dead, CLAIMS);
    expect(res.connected).toBe(true);
    expect(res.issues).toEqual([]);
    expect(res.note).toContain("fetch failed");
    clearTrackerCache();
  });
});
