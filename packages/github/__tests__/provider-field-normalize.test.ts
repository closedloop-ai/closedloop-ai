import { describe, expect, it } from "vitest";
import {
  getStatusCheckDedupeKey,
  hashProviderKey,
  normalizeProviderStatus,
  normalizeProviderText,
  parseProviderTimestamp,
  sanitizeProviderUrl,
} from "../provider-field-normalize";

const HEX_64_RE = /^[0-9a-f]{64}$/;

describe("parseProviderTimestamp", () => {
  it("parses an ISO string and returns 0 for null/invalid", () => {
    expect(parseProviderTimestamp("2026-08-04T00:00:00Z")).toBe(
      Date.parse("2026-08-04T00:00:00Z")
    );
    expect(parseProviderTimestamp(null)).toBe(0);
    expect(parseProviderTimestamp("not-a-date")).toBe(0);
  });
});

describe("normalizeProviderText / normalizeProviderStatus", () => {
  it("collapses whitespace, trims, truncates, and null-empties", () => {
    expect(normalizeProviderText("  a\n\t b  ", 64)).toBe("a b");
    expect(normalizeProviderText("abcdef", 3)).toBe("abc");
    expect(normalizeProviderText("   ", 64)).toBeNull();
    expect(normalizeProviderText(null, 64)).toBeNull();
  });

  it("upper-cases the normalized status", () => {
    expect(normalizeProviderStatus(" success ")).toBe("SUCCESS");
    expect(normalizeProviderStatus(null)).toBeNull();
  });
});

describe("getStatusCheckDedupeKey / hashProviderKey", () => {
  it("lower-cases the dedupe key and hashes to a stable 64-char hex", () => {
    expect(getStatusCheckDedupeKey("E2E")).toBe("e2e");
    const hash = hashProviderKey("some/context");
    expect(hash).toMatch(HEX_64_RE);
    expect(hashProviderKey("some/context")).toBe(hash);
  });
});

describe("sanitizeProviderUrl", () => {
  it("accepts http(s), rejects other schemes, over-long, and empty", () => {
    expect(sanitizeProviderUrl("https://ci.example.com/run/1")).toBe(
      "https://ci.example.com/run/1"
    );
    expect(sanitizeProviderUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeProviderUrl("not a url")).toBeNull();
    expect(sanitizeProviderUrl(`https://x/${"a".repeat(2100)}`)).toBeNull();
    expect(sanitizeProviderUrl(null)).toBeNull();
  });
});
