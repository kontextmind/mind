/**
 * kontext init — project wiring tests. Pure filesystem behavior (no server,
 * no DB): MCP config merge, commit-msg trailer hook semantics, AGENTS.md
 * contract idempotency, manifest, gitignore.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS_BEGIN, HOOK_MARKER, initProject } from "../src/init";

const SES = `km_ses_${"a".repeat(26)}`;

function gitInit(dir: string): void {
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
}

function runHook(proj: string, msgFile: string): void {
  const res = spawnSync("sh", [join(proj, ".git", "hooks", "commit-msg"), msgFile], {
    cwd: proj,
    encoding: "utf8",
  });
  expect(res.status).toBe(0); // fail-open: the hook never blocks a commit
}

describe("kontext init", () => {
  let proj: string;

  beforeAll(() => {
    proj = mkdtempSync(join(tmpdir(), "km-init-"));
    gitInit(proj);
    writeFileSync(join(proj, ".gitignore"), "node_modules\n");
  });

  afterAll(() => {
    rmSync(proj, { recursive: true, force: true });
  });

  test("refuses a non-git directory (git is the evidence spine)", () => {
    const bare = mkdtempSync(join(tmpdir(), "km-init-nogit-"));
    expect(() =>
      initProject({ projectDir: bare, url: "http://x/mcp", token: "t" }),
    ).toThrow(/not a git repository/);
    rmSync(bare, { recursive: true, force: true });
  });

  test("installs all project wiring", () => {
    const report = initProject({
      projectDir: proj,
      url: "http://km.local:3000/mcp",
      token: "tok-123",
    });
    expect(report).toMatchObject({
      mcp: "created",
      hook: "installed",
      agents: "created",
      manifest: "created",
      gitignore: "appended",
    });

    const mcp = JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.kontextmind.url).toBe("http://km.local:3000/mcp");
    expect(mcp.mcpServers.kontextmind.headers.Authorization).toBe("Bearer tok-123");

    const hook = join(proj, ".git", "hooks", "commit-msg");
    expect(readFileSync(hook, "utf8")).toContain(HOOK_MARKER);
    expect(statSync(hook).mode & 0o111).toBeTruthy(); // executable

    expect(readFileSync(join(proj, "AGENTS.md"), "utf8")).toContain(AGENTS_BEGIN);
    expect(readFileSync(join(proj, ".gitignore"), "utf8")).toContain(".kontextmind/session");
    expect(existsSync(join(proj, ".kontextmind", "kontext.json"))).toBe(true);
  });

  test("re-init is idempotent (nothing duplicated, nothing clobbered)", () => {
    writeFileSync(join(proj, ".mcp.json"), JSON.stringify({
      mcpServers: { other: { url: "http://other" }, kontextmind: { url: "old" } },
    }, null, 2));
    const report = initProject({
      projectDir: proj,
      url: "http://km.local:3000/mcp",
      token: "tok-123",
    });
    expect(report.mcp).toBe("merged");
    expect(report.agents).toBe("unchanged");
    expect(report.gitignore).toBe("unchanged");
    const mcp = JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.other.url).toBe("http://other"); // foreign server kept
    const agents = readFileSync(join(proj, "AGENTS.md"), "utf8");
    expect(agents.split(AGENTS_BEGIN).length).toBe(2); // exactly one section
  });

  test("hook appends the trailer once, from .kontextmind/session", () => {
    writeFileSync(join(proj, ".kontextmind", "session"), `${SES}\n`);
    const msg = join(proj, "msg.txt");
    writeFileSync(msg, "feat: do the thing\n");
    runHook(proj, msg);
    expect(readFileSync(msg, "utf8")).toBe(`feat: do the thing\n\nKM-Session: ${SES}\n`);
    // Idempotent: a second pass (amend, re-run) adds nothing.
    runHook(proj, msg);
    expect(readFileSync(msg, "utf8")).toBe(`feat: do the thing\n\nKM-Session: ${SES}\n`);
  });

  test("hook preserves other sessions' trailers (multi-session commits)", () => {
    const other = `km_ses_${"b".repeat(26)}`;
    const msg = join(proj, "msg2.txt");
    writeFileSync(msg, `pair: work\n\nKM-Session: ${other}\n`);
    runHook(proj, msg);
    const out = readFileSync(msg, "utf8");
    expect(out).toContain(`KM-Session: ${other}`);
    expect(out).toContain(`KM-Session: ${SES}`);
  });

  test("hook is fail-open: absent/malformed session leaves the message untouched", () => {
    const msg = join(proj, "msg3.txt");
    writeFileSync(msg, "feat: x\n");
    // Malformed session id.
    writeFileSync(join(proj, ".kontextmind", "session"), "not-a-session\n");
    runHook(proj, msg);
    expect(readFileSync(msg, "utf8")).toBe("feat: x\n");
    // Absent session file.
    rmSync(join(proj, ".kontextmind", "session"));
    runHook(proj, msg);
    expect(readFileSync(msg, "utf8")).toBe("feat: x\n");
  });

  test("a foreign commit-msg hook is never clobbered", () => {
    const foreign = mkdtempSync(join(tmpdir(), "km-init-fk-"));
    gitInit(foreign);
    const hook = join(foreign, ".git", "hooks", "commit-msg");
    writeFileSync(hook, "#!/bin/sh\necho custom\n");
    const report = initProject({ projectDir: foreign, url: "http://x/mcp", token: "t" });
    expect(report.hook).toBe("skipped-existing");
    expect(readFileSync(hook, "utf8")).toContain("echo custom");
    rmSync(foreign, { recursive: true, force: true });
  });

  test("CLI entry: `kontext init` smoke via spawn", () => {
    const cliProj = mkdtempSync(join(tmpdir(), "km-init-cli-"));
    gitInit(cliProj);
    const res = spawnSync(
      "bun",
      ["run", join(import.meta.dir, "..", "src", "index.ts"), "init",
       "--dir", cliProj, "--url", "http://cli.test/mcp", "--token", "tok"],
      { encoding: "utf8" },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("commit-msg hook   installed");
    expect(existsSync(join(cliProj, ".mcp.json"))).toBe(true);
    rmSync(cliProj, { recursive: true, force: true });
  });
});
