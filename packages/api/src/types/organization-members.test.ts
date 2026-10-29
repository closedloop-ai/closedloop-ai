import { describe, expect, it } from "vitest";
import { isOrganizationRole } from "./organization-members.ts";
import { OrganizationRole } from "./organization-role.ts";

describe("isOrganizationRole", () => {
  it("admits every role this product can write", () => {
    for (const role of Object.values(OrganizationRole)) {
      expect(isOrganizationRole(role)).toBe(true);
    }
  });

  it("rejects a custom Clerk role rather than narrowing it to a known one", () => {
    expect(isOrganizationRole("org:billing_manager")).toBe(false);
  });

  it("rejects an unprefixed role, which is the display axis and not a Clerk role", () => {
    expect(isOrganizationRole("admin")).toBe(false);
  });
});
