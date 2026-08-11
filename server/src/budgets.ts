/**
 * Per-identity budgets on /mcp (protocol.md: "rate limits per identity;
 * budgets per trust mode"; threat-model B1). The auth endpoints have their
 * own per-IP limiter (auth-server.ts); this one is per PRINCIPAL after
 * authentication — one noisy agent cannot starve the org's other identities.
 *
 * Fixed 60s window, in-memory (single-instance assumption, B6). Budgets fall
 * with the trust ladder; KM_MCP_RATE_LIMIT overrides for ops/tests.
 */
import type { Config } from "./config";

export const MCP_BUDGETS_PER_MIN: Record<Config["trustMode"], number> = {
  "local-demo": 600,
  relaxed: 300,
  standard: 120,
  strict: 30,
};

const windows = new Map<string, { start: number; count: number }>();

export function budgetFor(cfg: Config): number {
  const override = Number(process.env.KM_MCP_RATE_LIMIT ?? 0);
  if (override > 0) return override;
  return MCP_BUDGETS_PER_MIN[cfg.trustMode] ?? MCP_BUDGETS_PER_MIN.standard;
}

/** True when the principal is over budget (and the window was advanced). */
export function principalLimited(principal: string, limit: number, now = Date.now()): boolean {
  const w = windows.get(principal);
  if (!w || now - w.start > 60_000) {
    windows.set(principal, { start: now, count: 1 });
    return false;
  }
  w.count += 1;
  return w.count > limit;
}

export function resetBudgets(): void {
  windows.clear();
}
