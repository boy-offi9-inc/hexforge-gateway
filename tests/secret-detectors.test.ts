import { describe, it, expect } from "vitest";
import { detect, entropy, DETECTORS } from "../src/modules/mcp/agents/secret-detectors.js";

const REAL_AWS = "AKIAQW3RTYUIOP9JKLMN";
const PLACEHOLDER_AWS = "AKIAIOSFODNN7EXAMPLE";

function scan(lines: string[]) {
  return detect("test/file.java", lines);
}

describe("entropy", () => {
  it("is 0 for empty and constant strings", () => {
    expect(entropy("")).toBe(0);
    expect(entropy("aaaaaaaa")).toBe(0);
  });

  it("rates uniform random strings well above English text", () => {
    const random = entropy("j8Kp2mQ9zX4vB7nR");
    const english = entropy("password password");
    expect(random).toBeGreaterThan(3.5);
    expect(english).toBeLessThan(3);
  });
});

describe("detect", () => {
  it("finds an AWS access key with high confidence", () => {
    const [c] = scan([`aws_access_key_id = ${REAL_AWS}`]);
    expect(c.detector).toBe("AWS Access Key");
    expect(c.confidence).toBe("high");
    expect(c.signals.some((s) => s.includes("context keyword"))).toBe(true);
  });

  it("never includes the secret value in the candidate", () => {
    const candidates = scan([
      `key = ${REAL_AWS}`,
      "token = ghp_" + "a".repeat(36),
      "stripe = sk_live_" + "b".repeat(24),
      "-----BEGIN RSA PRIVATE KEY-----",
    ]);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(JSON.stringify(c)).not.toContain(REAL_AWS);
      expect(JSON.stringify(c)).not.toContain("ghp_aaaa");
      expect(JSON.stringify(c)).not.toContain("sk_live_");
      expect(c.preview.length).toBeLessThanOrEqual(4);
      expect(c.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(c.context).toContain("[REDACTED:");
    }
  });

  it("flags the AWS docs placeholder as low confidence", () => {
    const [c] = scan([PLACEHOLDER_AWS]);
    expect(c).toBeDefined();
    expect(c.confidence).toBe("low");
    expect(c.signals.some((s) => s.startsWith("placeholder"))).toBe(true);
  });

  it("downgrades high-entropy lookalikes without context", () => {
    const secret = "j8Kp2mQ9zX4vB7nRtY6uW3eA1xL5cV0bNq2HmT8w"; // 40 chars, AWS-secret shaped
    const [withContext] = scan(["aws_secret_access_key = " + secret]);
    expect(withContext.detector).toBe("AWS Secret Access Key");
    expect(withContext.confidence).toBe("high");
    const [noContext] = scan(["const digest = " + secret]);
    expect(noContext.confidence).not.toBe("high");
  });

  it("produces stable fingerprints for the same match", () => {
    const [a] = scan([`key = ${REAL_AWS}`]);
    const [b] = scan([`key = ${REAL_AWS}`]);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("carries file and 1-based line numbers", () => {
    const lines = ["", "", "", `token = ${"xoxb-123456-abcdefghijklmnop"}`];
    const [c] = scan(lines);
    expect(c.file).toBe("test/file.java");
    expect(c.line).toBe(4);
  });

  it("exports a detector registry larger than the original 8-pattern set", () => {
    expect(DETECTORS.length).toBeGreaterThanOrEqual(20);
    const names = new Set(DETECTORS.map((d) => d.name));
    expect(names.has("GitHub Token")).toBe(true);
    expect(names.has("Slack Webhook")).toBe(true);
    expect(names.has("SendGrid API Key")).toBe(true);
  });
});
