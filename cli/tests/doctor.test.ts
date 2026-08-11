/**
 * kontext doctor / version / update notice — installation health checks and
 * the release-notification machinery. Release checks use an injected fetch:
 * no network, deterministic, and proof that a failed check never throws.
 */
import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_VERSION, initProject } from "../src/init";
import {
  compareVersions,
  doctor,
  latestRelease,
  renderReport,
  serverVersion,
  updateNotice,
} from "../src/doctor";

describe("version compare + update notice", () => {
  test("compareVersions", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("v0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.1.1")).toBe(-1);
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
    expect(compareVersions("garbage", "0.1.0")).toBe(-1); // 0.0.0 < 0.1.0
  });

  test("updateNotice appears only for newer releases", () => {
    expect(updateNotice("0.1.0", "v0.1.0")).toBeNull();
    expect(updateNotice("0.2.0", "v0.1.0")).toBeNull();
    const n = updateNotice("0.1.0", "v0.2.0");
    expect(n).toContain("v0.2.0");
    expect(n).toContain("0.1.0");
    expect(n).toContain("kontext init");
  });
});

describe("doctor — installation health", () => {
  let proj: string;

  beforeAll(() => {
    proj = mkdtempSync(join(tmpdir(), "km-doctor-"));
    // Minimal git repo, then install.
    spawnSync("git", ["init", "-q"], { cwd: proj });
    initProject({ projectDir: proj, url: "http://km.test/mcp", token: "t" });
  });

  afterAll(() => {
    rmSync(proj, { recursive: true, force: true });
  });

  test("fresh install is healthy", () => {
    const r = doctor(proj, { cliVersion: CLI_VERSION });
    expect(r.broken).toBe(false);
    const labels = r.items.map((i) => i.label);
    expect(labels).toContain("git repository");
    expect(labels).toContain("commit-msg hook");
    expect(labels).toContain("AGENTS.md contract");
    expect(labels).toContain("manifest");
    expect(r.items.find((i) => i.label === "commit-msg hook")?.ok).toBe(true);
  });

  test("missing hook is BROKEN", () => {
    unlinkSync(join(proj, ".git", "hooks", "commit-msg"));
    const r = doctor(proj, { cliVersion: CLI_VERSION });
    expect(r.broken).toBe(true);
    expect(r.items.find((i) => i.label === "commit-msg hook")?.ok).toBe(false);
    // restore for later tests
    initProject({ projectDir: proj, url: "http://km.test/mcp", token: "t" });
  });

  test("non-executable hook is BROKEN", () => {
    chmodSync(join(proj, ".git", "hooks", "commit-msg"), 0o644);
    const r = doctor(proj, { cliVersion: CLI_VERSION });
    expect(r.broken).toBe(true);
    chmodSync(join(proj, ".git", "hooks", "commit-msg"), 0o755);
  });

  test("manifest installed by an older CLI warns to re-run init", () => {
    const mPath = join(proj, ".kontextmind", "kontext.json");
    const m = JSON.parse(readFileSync(mPath, "utf8"));
    writeFileSync(mPath, JSON.stringify({ ...m, cli_version: "0.0.1" }));
    const r = doctor(proj, { cliVersion: CLI_VERSION });
    const manifest = r.items.find((i) => i.label === "manifest");
    expect(manifest?.warn).toBe(true);
    expect(manifest?.detail).toContain("re-run");
    // Same-version manifest does not warn.
    writeFileSync(mPath, JSON.stringify({ ...m, cli_version: CLI_VERSION }));
    const r2 = doctor(proj, { cliVersion: CLI_VERSION });
    expect(r2.items.find((i) => i.label === "manifest")?.warn).toBeFalsy();
  });

  test("server drift and reachability are reported honestly", () => {
    const unreachable = doctor(proj, { cliVersion: CLI_VERSION, serverVersion: null });
    expect(unreachable.items.find((i) => i.label === "server")?.warn).toBe(true);
    const newer = doctor(proj, { cliVersion: "0.1.0", serverVersion: "0.2.0" });
    expect(newer.items.find((i) => i.label === "server")?.detail).toContain("update the CLI");
  });

  test("non-git directory is BROKEN", () => {
    const bare = mkdtempSync(join(tmpdir(), "km-doctor-nogit-"));
    const r = doctor(bare, { cliVersion: CLI_VERSION });
    expect(r.broken).toBe(true);
    expect(renderReport(r, null)).toContain("BROKEN");
    rmSync(bare, { recursive: true, force: true });
  });

  test("renderReport shows marks and the update notice", () => {
    const r = doctor(proj, { cliVersion: CLI_VERSION });
    const out = renderReport(r, "KontextMind v9.9.9 is out (you are on 0.1.0).");
    expect(out).toContain("✓ git repository");
    expect(out).toContain("v9.9.9");
    expect(out).toContain("healthy");
  });
});

describe("release check — throttled, silent, opt-out", () => {
  let cfgDir: string;

  beforeAll(() => {
    cfgDir = mkdtempSync(join(tmpdir(), "km-cfg-release-"));
  });

  beforeEach(() => {
    process.env.KM_CONFIG_DIR = cfgDir;
    delete process.env.KM_NO_UPDATE_CHECK;
    rmSync(join(cfgDir, "update-check.json"), { force: true });
  });

  afterAll(() => {
    delete process.env.KM_CONFIG_DIR;
    rmSync(cfgDir, { recursive: true, force: true });
  });

  test("fetches latest tag, then serves from cache within 24h", async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response(JSON.stringify({ tag_name: "v9.9.9" }), { status: 200 });
    }) as unknown as typeof fetch;

    const first = await latestRelease("0.1.0", Date.now(), fake);
    expect(first).toBe("v9.9.9");
    expect(calls).toBe(1);
    const second = await latestRelease("0.1.0", Date.now() + 1000, fake);
    expect(second).toBe("v9.9.9");
    expect(calls).toBe(1); // cache hit — no second network call
    // Past the interval the network is consulted again.
    await latestRelease("0.1.0", Date.now() + 25 * 3600 * 1000, fake);
    expect(calls).toBe(2);
  });

  test("KM_NO_UPDATE_CHECK=1 disables the check entirely", async () => {
    process.env.KM_NO_UPDATE_CHECK = "1";
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await latestRelease("0.1.0", Date.now(), fake)).toBeNull();
    expect(calls).toBe(0);
  });

  test("network failure is silent (a release check never breaks a command)", async () => {
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await latestRelease("0.1.0", Date.now(), boom)).toBeNull();
  });

  test("serverVersion reads /healthz and degrades to null", async () => {
    const ok = (async () =>
      new Response(JSON.stringify({ ok: true, version: "1.2.3" }), { status: 200 })) as unknown as typeof fetch;
    expect(await serverVersion("http://x:1/mcp", ok)).toBe("1.2.3");
    const down = (async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;
    expect(await serverVersion("http://x:1/mcp", down)).toBeNull();
  });
});
