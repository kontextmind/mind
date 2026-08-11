/**
 * Version lockstep: every package ships together. Skew between cli, serve,
 * and server breaks user expectations (kontext doctor compares CLI vs
 * server) — so the suite asserts parity on every run.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const version = (p: string) =>
  (JSON.parse(readFileSync(join(root, p, "package.json"), "utf8")) as { version: string }).version;

describe("version lockstep", () => {
  test("cli, serve, and server versions are identical", () => {
    const versions = {
      cli: version("cli"),
      serve: version("serve"),
      server: version("server"),
    };
    expect(new Set(Object.values(versions)).size).toBe(1);
  });

  test("versions are semver", () => {
    expect(version("cli")).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
