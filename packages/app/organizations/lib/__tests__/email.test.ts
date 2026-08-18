import { describe, expect, it } from "vitest";
import { collectEmails, EMAIL_REGEX } from "../email";

describe("collectEmails", () => {
  it("trims, lowercases, and dedupes valid addresses", () => {
    const { valid, invalid } = collectEmails([
      "  Alice@Example.com ",
      "alice@example.com",
      "BOB@example.com",
    ]);

    expect(valid).toEqual(["alice@example.com", "bob@example.com"]);
    expect(invalid).toEqual([]);
  });

  it("skips blank/whitespace-only entries", () => {
    const { valid, invalid } = collectEmails(["", "   ", "a@b.co"]);

    expect(valid).toEqual(["a@b.co"]);
    expect(invalid).toEqual([]);
  });

  it("partitions malformed addresses into invalid", () => {
    const { valid, invalid } = collectEmails([
      "good@example.com",
      "not-an-email",
      "missing@domain",
      "@no-local.com",
    ]);

    expect(valid).toEqual(["good@example.com"]);
    expect(invalid).toEqual([
      "not-an-email",
      "missing@domain",
      "@no-local.com",
    ]);
  });

  it("dedupes invalid entries too", () => {
    const { invalid } = collectEmails(["nope", "NOPE", " nope "]);

    expect(invalid).toEqual(["nope"]);
  });

  it("EMAIL_REGEX matches a basic address and rejects obvious typos", () => {
    expect(EMAIL_REGEX.test("teammate@company.com")).toBe(true);
    expect(EMAIL_REGEX.test("teammate@company")).toBe(false);
    expect(EMAIL_REGEX.test("teammate company.com")).toBe(false);
  });
});
