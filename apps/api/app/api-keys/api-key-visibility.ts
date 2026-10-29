import {
  isOrgAdminRole,
  OrgAdminRole,
} from "@repo/api/src/types/org-admin-role";

/**
 * Which API keys a caller may see and revoke.
 */
export const ApiKeyVisibility = {
  /** Every key in the organization, whoever minted it. */
  Organization: "organization",
  /** Only the caller's own keys. */
  Own: "own",
} as const;
export type ApiKeyVisibility =
  (typeof ApiKeyVisibility)[keyof typeof ApiKeyVisibility];

/**
 * What each privileged Clerk role sees.
 *
 * Exhaustive by construction: a role added to `OrgAdminRole` fails typecheck
 * here until someone decides what it sees, instead of falling through to the
 * own-keys branch. ISS-8661 is that fall-through — the gate compared against
 * the `"org:admin"` literal at two sites and never `"org:owner"`, so an org
 * OWNER saw strictly less than an admin.
 */
const API_KEY_VISIBILITY_BY_ORG_ADMIN_ROLE: Record<
  OrgAdminRole,
  ApiKeyVisibility
> = {
  [OrgAdminRole.Admin]: ApiKeyVisibility.Organization,
  [OrgAdminRole.Owner]: ApiKeyVisibility.Organization,
};

/**
 * Resolve a Clerk membership role to the key set it may reach. An absent role
 * is "not a member with a privileged role", which is the own-keys answer.
 */
export function apiKeyVisibilityForOrgRole(
  orgRole: string | undefined
): ApiKeyVisibility {
  if (orgRole === undefined || !isOrgAdminRole(orgRole)) {
    return ApiKeyVisibility.Own;
  }
  return API_KEY_VISIBILITY_BY_ORG_ADMIN_ROLE[orgRole];
}
