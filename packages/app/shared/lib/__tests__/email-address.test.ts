import { describe, expect, it } from "vitest";
import { EMAIL_REGEX, isValidEmailAddress } from "../email-address";

describe("isValidEmailAddress", () => {
  it("EMAIL_REGEX matches a basic address and rejects obvious typos", () => {
    expect(EMAIL_REGEX.test("teammate@company.com")).toBe(true);
    expect(EMAIL_REGEX.test("teammate@company")).toBe(false);
    expect(EMAIL_REGEX.test("teammate company.com")).toBe(false);
  });

  it("rejects malformed domain labels and local parts", () => {
    expect(isValidEmailAddress("teammate@-company.com")).toBe(false);
    expect(isValidEmailAddress("teammate@company-.com")).toBe(false);
    expect(isValidEmailAddress("two..dots@company.com")).toBe(false);
    expect(isValidEmailAddress(".leading@company.com")).toBe(false);
    expect(isValidEmailAddress("teammate@company.com")).toBe(true);
  });
});
