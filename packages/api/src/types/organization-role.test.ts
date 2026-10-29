import { describe, expect, it } from "vitest";
import { OrgInviteRole } from "./onboarding.ts";
import { OrgAdminRole } from "./org-admin-role.ts";
import { OrganizationRole } from "./organization-role.ts";

describe("OrganizationRole", () => {
  it("is exactly the union of the two owners, with no fourth role invented here", () => {
    const owned = new Set<string>([
      ...Object.values(OrgInviteRole),
      ...Object.values(OrgAdminRole),
    ]);

    expect([...Object.values(OrganizationRole)].sort()).toEqual(
      [...owned].sort()
    );
  });
});
