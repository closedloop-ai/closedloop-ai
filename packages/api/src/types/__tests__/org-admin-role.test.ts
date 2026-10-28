import { describe, expect, it } from "vitest";
import { isOrgAdminRole, OrgAdminRole } from "../org-admin-role";

describe("OrgAdminRole", () => {
  // This set is an authorization boundary shared by the API admin gate and the
  // client admin affordances. Dropping a member revokes every admin-gated route
  // and every admin control for that role, so the membership is pinned here
  // rather than left to whichever consumer happens to have coverage.
  it("carries exactly the two privileged Clerk roles", () => {
    expect(Object.values(OrgAdminRole)).toEqual(["org:admin", "org:owner"]);
  });

  it.each([OrgAdminRole.Admin, OrgAdminRole.Owner])(
    "grants admin access to %s",
    (role) => {
      expect(isOrgAdminRole(role)).toBe(true);
    }
  );

  it.each(["org:member", "org:billing", "admin", "owner", ""])(
    "denies admin access to %s",
    (role) => {
      expect(isOrgAdminRole(role)).toBe(false);
    }
  );
});
