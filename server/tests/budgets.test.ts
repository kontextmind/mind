/**
 * Per-identity MCP budgets (protocol.md). Unit semantics + an integration
 * check through the real fetch handler: third request over a budget of two
 * gets a 429 with Retry-After.
 */
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { budgetFor, MCP_BUDGETS_PER_MIN, principalLimited, resetBudgets } from "../src/budgets";
import { createFetch } from "../src/app";
import { resolveDbUrl } from "../../tests/support/db";
import type { Config } from "../src/config";

// /mcp degrades to 503 without DATABASE_URL set (no connection is actually
// made by this suite — the budget gate sits in front of the handler).
resolveDbUrl("budgets");

const cfgOf = (trustMode: Config["trustMode"]): Config => ({
  mode: "demo",
  port: 0,
  demoToken: "km-demo-local",
  trustMode,
  mindPath: null,
  appPassword: "x",
  githubWebhookSecret: null,
  publicUrl: null,
  bootstrapEmails: [],
  ownerAuth: "allowlist",
  github: null,
  githubApi: "https://api.github.com",
  githubApiToken: null,
  authRateLimit: 10000,
});

describe("per-identity MCP budgets", () => {
  beforeEach(() => {
    resetBudgets();
    delete process.env.KM_MCP_RATE_LIMIT;
  });

  afterAll(() => {
    // bun test shares the process across files: the override must not leak
    // into later suites' /mcp traffic.
    delete process.env.KM_MCP_RATE_LIMIT;
    resetBudgets();
  });

  test("budgets fall with the trust ladder", () => {
    expect(MCP_BUDGETS_PER_MIN["local-demo"]).toBeGreaterThan(MCP_BUDGETS_PER_MIN.relaxed);
    expect(MCP_BUDGETS_PER_MIN.relaxed).toBeGreaterThan(MCP_BUDGETS_PER_MIN.standard);
    expect(MCP_BUDGETS_PER_MIN.standard).toBeGreaterThan(MCP_BUDGETS_PER_MIN.strict);
    expect(budgetFor(cfgOf("strict"))).toBe(30);
  });

  test("fixed window: under budget passes, over budget blocks, window rolls", () => {
    const t0 = 1_000_000;
    expect(principalLimited("p1", 2, t0)).toBe(false);
    expect(principalLimited("p1", 2, t0 + 1)).toBe(false);
    expect(principalLimited("p1", 2, t0 + 2)).toBe(true);
    // Principals are independent.
    expect(principalLimited("p2", 2, t0 + 3)).toBe(false);
    // Past 60s the window resets.
    expect(principalLimited("p1", 2, t0 + 61_001)).toBe(false);
  });

  test("KM_MCP_RATE_LIMIT overrides the trust-mode budget", () => {
    process.env.KM_MCP_RATE_LIMIT = "7";
    expect(budgetFor(cfgOf("strict"))).toBe(7);
  });

  test("over-budget /mcp request → 429 + Retry-After", async () => {
    process.env.KM_MCP_RATE_LIMIT = "2";
    const handler = createFetch(cfgOf("local-demo"));
    const post = () =>
      handler(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: { Authorization: "Bearer km-demo-local", "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        }),
      );
    const r1 = await post();
    const r2 = await post();
    expect(r1.status).not.toBe(429);
    expect(r2.status).not.toBe(429);
    const r3 = await post();
    expect(r3.status).toBe(429);
    expect(r3.headers.get("retry-after")).toBe("60");
    // Unauthenticated requests still fail auth, not budget.
    const anon = await handler(
      new Request("http://localhost/mcp", { method: "POST", body: "{}" }),
    );
    expect(anon.status).toBe(401);
  });
});
