import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { verifyGithubSignature } from "../src/index";

describe("verifyGithubSignature", () => {
  const body = JSON.stringify({ repository: { full_name: "owner/repo" } });
  const secret = "test-webhook-secret";
  const signature = `sha256=${createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("hex")}`;

  test("accepts the signature for the exact raw body", () => {
    expect(verifyGithubSignature(body, signature, secret)).toBe(true);
  });

  test("fails closed for missing, malformed, or mismatched signatures", () => {
    expect(verifyGithubSignature(body, undefined, secret)).toBe(false);
    expect(verifyGithubSignature(body, "sha256=short", secret)).toBe(false);
    expect(verifyGithubSignature(`${body}\n`, signature, secret)).toBe(false);
  });
});
