import { OrgAdminRole } from "@repo/api/src/types/org-admin-role";
import { describe, expect, it } from "vitest";
import { hasAdminRole, isAdminRole } from "../role-utils";

function clerkHasFor(granted: string) {
  return ({ role }: { role: string }) => role === granted;
}

describe("isAdminRole", () => {
  // Reads the canonical role set rather than restating it: this asserts the
  // client gate actually honours whatever the shared contract declares, so
  // narrowing that contract fails here as well as on the API side.
  it.each([OrgAdminRole.Admin, OrgAdminRole.Owner])(
    "accepts the %s role",
    (role) => {
      expect(isAdminRole(role)).toBe(true);
    }
  );

  it("rejects member and unknown roles", () => {
    expect(isAdminRole("org:member")).toBe(false);
    expect(isAdminRole("org:billing")).toBe(false);
  });

  it("rejects empty and undefined roles", () => {
    expect(isAdminRole("")).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
  });
});

describe("hasAdminRole", () => {
  // Each caller holds exactly ONE of the privileged roles, so a gate that only
  // asked Clerk about the first canonical role would deny the other one — the
  // precise failure this helper exists to make impossible.
  it.each([OrgAdminRole.Admin, OrgAdminRole.Owner])(
    "admits a caller whose only role is %s",
    (role) => {
      expect(hasAdminRole(clerkHasFor(role))).toBe(true);
    }
  );

  it("denies a caller holding no privileged role", () => {
    expect(hasAdminRole(clerkHasFor("org:member"))).toBe(false);
  });
});
