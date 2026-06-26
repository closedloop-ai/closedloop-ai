import { describe, expect, it } from "vitest";
import {
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
