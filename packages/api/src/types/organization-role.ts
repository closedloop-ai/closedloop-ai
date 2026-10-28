import { OrgInviteRole } from "./onboarding.ts";
import { OrgAdminRole } from "./org-admin-role.ts";

/**
 * The whole Clerk organization-role axis this product writes: member, admin,
 * owner. It is the set a membership role may be CHANGED to, and the set a
 * roster read can recognise.
 *
 * WHY A FOURTH CONST WHEN THREE ALREADY EXIST. None of them covers this axis.
 * `OrgInviteRole` is the ASSIGNABLE-at-invite set (admin/member) and has no
 * owner. `OrgAdminRole` is the AUTHORITY-granting set (admin/owner) and has no
 * member. `SettingsActorRole` is the unprefixed display axis and is not a Clerk
 * role string at all. A gate written against the wrong one silently excludes a
 * role: `apps/api/app/api-keys/service.ts` compares `orgRole === "org:admin"`
 * and so excludes `org:owner`, which is the bug this const exists to stop
 * recurring.
 *
 * COMPOSED, NOT RE-SPELLED. The literals are read off the two existing owners
 * rather than typed again, so this is not a fourth declaration of `"org:admin"`
 * that can drift from the ones the admin gate reads.
 *
 * NOT the set a Clerk instance can RETURN. `OrganizationMembershipRole` is
 * `OrganizationCustomRoleKey`, an open string, so a roster read passes the
 * provider's value through verbatim and uses `isOrganizationRole` to ask
 * whether it is one of these — it never coerces an unknown role into one.
 */
export const OrganizationRole = {
  Member: OrgInviteRole.Member,
  Admin: OrgAdminRole.Admin,
  Owner: OrgAdminRole.Owner,
} as const;

export type OrganizationRole =
  (typeof OrganizationRole)[keyof typeof OrganizationRole];
