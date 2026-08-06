import { describe, expect, test } from "bun:test";
import { newSessionId, parseKmTrailers } from "../server/src/session";

describe("newSessionId", () => {
  test("format km_ses_<26 lowercase chars>", () => {
    const id = newSessionId();
    expect(id).toMatch(/^km_ses_[0-9a-z]{26}$/);
  });
  test("unique across calls", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSessionId()));
    expect(ids.size).toBe(200);
  });
});

describe("parseKmTrailers (Agent Evidence Trailers v1)", () => {
  test("parses a single trailer", () => {
    const msg = `feat: thing\n\nKM-Session: ${"km_ses_" + "a".repeat(26)}\n`;
    expect(parseKmTrailers(msg)).toEqual(["km_ses_" + "a".repeat(26)]);
  });

  test("parses multiple trailers in order", () => {
    const a = "km_ses_" + "a".repeat(26);
    const b = "km_ses_" + "b".repeat(26);
    const msg = `fix: y\n\nKM-Session: ${a}\nKM-Session: ${b}\n`;
    expect(parseKmTrailers(msg)).toEqual([a, b]);
  });

  test("ignores malformed values (never silently passes them through)", () => {
    const msg = "KM-Session: not-a-session-id\nKM-Session: km_ses_short\n";
    expect(parseKmTrailers(msg)).toEqual([]);
  });

  test("absent trailer = empty list (omission is allowed)", () => {
    expect(parseKmTrailers("feat: no trailer here\n")).toEqual([]);
  });

  test("trailer mid-message is found", () => {
    const id = "km_ses_" + "c".repeat(26);
    const msg = `feat: z\n\nKM-Session: ${id}\nCo-authored-by: x <x@y.z>\n`;
    expect(parseKmTrailers(msg)).toEqual([id]);
  });
});
