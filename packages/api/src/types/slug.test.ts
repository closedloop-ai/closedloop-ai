import { describe, expect, it } from "vitest";
import { isDisplayableSlug, TYPED_SLUG_PATTERN } from "./slug";

// Literal slugs, not ones built from SlugPrefix: a fixture derived from the
// same const as the pattern stays green when a prefix is dropped from both.
describe("TYPED_SLUG_PATTERN (ISS-10984)", () => {
  it.each([
    "PRO-1",
    "WRK-99",
    "PRD-42",
    "PLN-7",
    "FEA-123",
    "ISS-123",
    "DOC-39",
  ])("accepts the typed slug %s", (slug) => {
    expect(TYPED_SLUG_PATTERN.test(slug)).toBe(true);
    expect(isDisplayableSlug(slug)).toBe(true);
  });

  it("keeps session slugs out, as before (sessions route by id)", () => {
    expect(TYPED_SLUG_PATTERN.test("SES-5")).toBe(false);
    expect(isDisplayableSlug("SES-5")).toBe(false);
  });

  it("rejects unknown prefixes and nanoid slugs", () => {
    expect(TYPED_SLUG_PATTERN.test("FOO-1")).toBe(false);
    expect(TYPED_SLUG_PATTERN.test("DOC-")).toBe(false);
    expect(isDisplayableSlug("m4e8g7k2j9h5b3")).toBe(false);
  });
});
