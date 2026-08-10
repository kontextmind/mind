import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifySignature } from "../server/src/webhook";

const SECRET = "whsec-test-only";
const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

describe("verifySignature (GitHub X-Hub-Signature-256)", () => {
  test("accepts a valid signature", () => {
    const body = JSON.stringify({ zen: "anything worth doing is worth overdoing" });
    expect(verifySignature(SECRET, body, sign(body))).toBe(true);
  });

  test("accepts uppercase hex (normalized before compare)", () => {
    const body = "{}";
    expect(verifySignature(SECRET, body, sign(body).toUpperCase().replace("SHA256", "sha256"))).toBe(true);
  });

  test("rejects a signature from the wrong secret", () => {
    const body = "{}";
    expect(verifySignature(SECRET, body, sign(body, "attacker-secret"))).toBe(false);
  });

  test("rejects when the body was altered after signing", () => {
    const body = JSON.stringify({ repository: { full_name: "acme/mind" } });
    expect(verifySignature(SECRET, body + " ", sign(body))).toBe(false);
  });

  test("rejects missing header", () => {
    expect(verifySignature(SECRET, "{}", null)).toBe(false);
  });

  test("rejects non-sha256 prefix (sha1 downgrade, bare hex)", () => {
    const body = "{}";
    const hex = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifySignature(SECRET, body, `sha1=${hex}`)).toBe(false);
    expect(verifySignature(SECRET, body, hex)).toBe(false);
  });

  test("rejects wrong-length hex without throwing", () => {
    expect(verifySignature(SECRET, "{}", "sha256=deadbeef")).toBe(false);
  });
});
