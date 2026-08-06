import { describe, expect, test } from "bun:test";
import { scanContent, isLowRiskLearning } from "../server/src/secrets";

describe("gate 2: deterministic secret scanner", () => {
  test("clean content passes", () => {
    const res = scanContent("# Learning\n\nWe chose Postgres for RLS support.");
    expect(res.clean).toBe(true);
    expect(res.findings).toEqual([]);
  });

  test("catches provider keys", () => {
    expect(scanContent("key = sk-abcdefghij1234567890ABCD").clean).toBe(false);
    expect(scanContent("k: sk-ant-api03-abcdefgh1234567890").clean).toBe(false);
  });

  test("catches github tokens", () => {
    const res = scanContent("token: ghp_ABCDEFGHIJ1234567890abcdefghij");
    expect(res.findings.some((f) => f.rule === "github-token")).toBe(true);
  });

  test("catches private key blocks", () => {
    const res = scanContent("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----");
    expect(res.findings.some((f) => f.rule === "private-key-block")).toBe(true);
  });

  test("catches connection strings with credentials", () => {
    const res = scanContent("DATABASE_URL=postgres://admin:hunter2secret@db:5432/app");
    expect(res.findings.some((f) => f.rule === "connection-string")).toBe(true);
  });

  test("catches JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc123def456ghi789";
    expect(scanContent(`auth: ${jwt}`).findings.some((f) => f.rule === "jwt")).toBe(true);
  });

  test("catches high-entropy blobs but not git SHAs", () => {
    const blob = "Xk9mQ2vL7pR4tY8wB3nJ6hF5dS1gA0cE9uZ2oI4q";
    expect(scanContent(`secret: ${blob}`).findings.some((f) => f.rule === "high-entropy-blob")).toBe(true);
    const sha = "c4cb4764ed3e75a161f7810ba81b8f9a63f63392";
    expect(scanContent(`indexed @ ${sha}`).clean).toBe(true);
  });

  test("per-org denylist matches case-insensitively", () => {
    const res = scanContent("Met with Acme Corp about the rollout.", { denylist: ["acme corp"] });
    expect(res.findings.some((f) => f.rule === "denylist:acme corp")).toBe(true);
  });

  test("findings never contain the matched secret itself", () => {
    const res = scanContent("token: ghp_ABCDEFGHIJ1234567890abcdefghij");
    for (const f of res.findings) {
      expect(JSON.stringify(f)).not.toContain("ghp_ABCDEFGHIJ");
    }
  });
});

describe("relaxed-mode auto-promote rule", () => {
  test("short factual one-liner is low-risk", () => {
    expect(isLowRiskLearning("Bun install needs --no-save on Windows due to a lockfile bug.")).toBe(true);
  });
  test("long content is not low-risk", () => {
    expect(isLowRiskLearning("x ".repeat(150))).toBe(false);
  });
  test("code is not low-risk", () => {
    expect(isLowRiskLearning("Run `bun test` before pushing.".repeat(1))).toBe(false);
  });
  test("file paths are not low-risk", () => {
    expect(isLowRiskLearning("See docs/trust-modes.md for the matrix.")).toBe(false);
  });
});
