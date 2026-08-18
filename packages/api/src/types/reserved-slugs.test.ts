import { describe, expect, it } from "vitest";
import {
  isPathSafeSlug,
  isReservedOrgSlug,
  orgSlugSchema,
  RESERVED_ORG_SLUGS,
} from "./reserved-slugs";

describe("RESERVED_ORG_SLUGS", () => {
  it("contains all non-org-scoped top-level routes", () => {
    const required = [
      "sign-in",
      "sign-up",
      "onboarding",
      "api",
      "d",
      "rum-validation",
      "auth",
      "sso",
      "oauth",
      "callback",
      // PLN-1526. The list is matched whole-segment, so the "sso" and
      // "callback" entries above do NOT reserve "sso-callback", and nothing
      // reserves "connect" by implication. Both routes live outside the
      // org-scoped layout, so an org holding either slug would be shadowed by
      // the static route.
      "connect",
      "sso-callback",
      "_next",
    ];
    for (const slug of required) {
      expect(RESERVED_ORG_SLUGS).toContain(slug);
    }
  });

  it("does not contain org-scoped routes", () => {
    const orgScoped = [
      "prds",
      "features",
      "settings",
      "agents",
      "loops",
      "teams",
    ];
    for (const slug of orgScoped) {
      expect(RESERVED_ORG_SLUGS).not.toContain(slug);
    }
  });
});

describe("isReservedOrgSlug", () => {
  it("returns true for reserved slugs", () => {
    expect(isReservedOrgSlug("api")).toBe(true);
    expect(isReservedOrgSlug("sign-in")).toBe(true);
    expect(isReservedOrgSlug("rum-validation")).toBe(true);
    expect(isReservedOrgSlug("_next")).toBe(true);
    expect(isReservedOrgSlug("auth")).toBe(true);
  });

  it("returns false for non-reserved slugs", () => {
    expect(isReservedOrgSlug("closedloop")).toBe(false);
    expect(isReservedOrgSlug("acme-corp")).toBe(false);
    expect(isReservedOrgSlug("my-org")).toBe(false);
    expect(isReservedOrgSlug("settings")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isReservedOrgSlug("API")).toBe(true);
    expect(isReservedOrgSlug("SIGN-IN")).toBe(true);
    expect(isReservedOrgSlug("Auth")).toBe(true);
  });
});

describe("orgSlugSchema", () => {
  it("accepts valid slugs", () => {
    expect(orgSlugSchema.safeParse("closedloop").success).toBe(true);
    expect(orgSlugSchema.safeParse("acme-corp").success).toBe(true);
    expect(orgSlugSchema.safeParse("my-org-123").success).toBe(true);
    expect(orgSlugSchema.safeParse("a1").success).toBe(true);
  });

  it("rejects reserved slugs", () => {
    const result = orgSlugSchema.safeParse("api");
    expect(result.success).toBe(false);
  });

  it("rejects slugs that are too short", () => {
    const result = orgSlugSchema.safeParse("a");
    expect(result.success).toBe(false);
  });

  it("rejects slugs that are too long", () => {
    const result = orgSlugSchema.safeParse("a".repeat(65));
    expect(result.success).toBe(false);
  });

  it("accepts slugs at boundary lengths", () => {
    expect(orgSlugSchema.safeParse("ab").success).toBe(true);
    expect(orgSlugSchema.safeParse("a".repeat(64)).success).toBe(true);
  });

  it("rejects slugs with uppercase letters", () => {
    const result = orgSlugSchema.safeParse("MyOrg");
    expect(result.success).toBe(false);
  });

  it("rejects slugs with spaces", () => {
    const result = orgSlugSchema.safeParse("my org");
    expect(result.success).toBe(false);
  });

  it("rejects slugs with special characters", () => {
    expect(orgSlugSchema.safeParse("my_org").success).toBe(false);
    expect(orgSlugSchema.safeParse("my.org").success).toBe(false);
    expect(orgSlugSchema.safeParse("my@org").success).toBe(false);
  });

  it("rejects slugs starting or ending with hyphens", () => {
    expect(orgSlugSchema.safeParse("-myorg").success).toBe(false);
    expect(orgSlugSchema.safeParse("myorg-").success).toBe(false);
    expect(orgSlugSchema.safeParse("-myorg-").success).toBe(false);
  });

  it("rejects empty strings", () => {
    expect(orgSlugSchema.safeParse("").success).toBe(false);
  });
});

describe("isPathSafeSlug", () => {
  it("accepts normal kebab-case org slugs", () => {
    expect(isPathSafeSlug("closedloop")).toBe(true);
    expect(isPathSafeSlug("acme-corp")).toBe(true);
    expect(isPathSafeSlug("my-org-123")).toBe(true);
  });

  it("accepts legacy Clerk-id-fallback slugs that orgSlugSchema rejects", () => {
    // findOrCreateByClerkId writes the raw Clerk org id (underscores + mixed
    // case) as the slug when Clerk has no slug; these must still forward, not
    // 404, so a redirect gate cannot use the kebab-only orgSlugSchema.
    const legacyClerkSlug = "org_2abcDEF0123456789";
    expect(orgSlugSchema.safeParse(legacyClerkSlug).success).toBe(false);
    expect(isPathSafeSlug(legacyClerkSlug)).toBe(true);
    expect(isPathSafeSlug("org_legacy_clerk_id")).toBe(true);
  });

  it("rejects empty strings", () => {
    expect(isPathSafeSlug("")).toBe(false);
  });

  it("rejects forward slashes so a segment cannot reshape the path", () => {
    expect(isPathSafeSlug("evil/../other")).toBe(false);
    expect(isPathSafeSlug("a/b")).toBe(false);
  });

  it("rejects a decoded encoded-slash open-redirect payload", () => {
    // Next.js decodes %2F before the route param reaches this gate, so the
    // decoded literal slash must be what we reject.
    expect(isPathSafeSlug("/evil.example")).toBe(false);
    expect(isPathSafeSlug("//evil.example")).toBe(false);
  });

  it("rejects query/fragment separators that would reshape the redirect target", () => {
    // Each caller interpolates this value RAW into `redirect('/${orgSlug}/…')`,
    // so a "?" or "#" splices a query string / fragment onto the destination.
    expect(isPathSafeSlug("foo?next=/evil")).toBe(false);
    expect(isPathSafeSlug("foo#/evil")).toBe(false);
    // Next decodes an encoded "%3F"/"%23" before it reaches this gate, so it
    // arrives as a literal "?"/"#" and is caught by the same rule.
  });

  it("rejects '%' so a double-encoded delimiter cannot survive still-encoded", () => {
    // A "%25..." (double-encoded) payload decodes ONCE to "%3F" before reaching
    // this gate; rejecting "%" stops that still-encoded form from surviving into
    // a later navigation that would decode it into a "?".
    expect(isPathSafeSlug("%2Fevil.example")).toBe(false);
    expect(isPathSafeSlug("foo%3Fnext")).toBe(false);
    expect(isPathSafeSlug("foo%25")).toBe(false);
  });

  it("rejects backslashes", () => {
    expect(isPathSafeSlug("a\\b")).toBe(false);
  });

  it("rejects leading dots so a slug cannot climb the path", () => {
    expect(isPathSafeSlug("..")).toBe(false);
    expect(isPathSafeSlug(".hidden")).toBe(false);
  });

  it("rejects control characters (incl. NUL, newline, tab, and DEL)", () => {
    expect(isPathSafeSlug(`a${String.fromCharCode(0)}b`)).toBe(false);
    expect(isPathSafeSlug(`a${String.fromCharCode(10)}b`)).toBe(false);
    expect(isPathSafeSlug(`a${String.fromCharCode(9)}b`)).toBe(false);
    expect(isPathSafeSlug(`a${String.fromCharCode(127)}b`)).toBe(false);
  });

  it("does not reject a plain space (0x20 is above the control range)", () => {
    // The gate only blocks path-reshaping and control chars, not every
    // non-slug character; a space cannot forge an off-site redirect.
    expect(isPathSafeSlug("a b")).toBe(true);
  });
});
