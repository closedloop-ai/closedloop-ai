/**
 * Client-side role utilities.
 */

import {
  isOrgAdminRole,
  OrgAdminRole,
} from "@repo/api/src/types/org-admin-role";

/**
 * Check if a Clerk membership role has admin-level access. The role set itself
 * is owned by `@repo/api/src/types/org-admin-role`, which the backend admin
 * gate reads too, so this check cannot drift from the server's.
 */
export function isAdminRole(role: string | undefined): boolean {
  return !!role && isOrgAdminRole(role);
}

/**
 * Clerk's `has()` predicate, narrowed to the role question. Declared
 * structurally so both the server `auth()` helper and the `Show` render-prop
 * form satisfy it without a cast.
 */
type ClerkRoleCheck = (params: { role: string }) => boolean;

/**
 * The `has()`-shaped counterpart of `isAdminRole`, for the Clerk surfaces that
 * ask about one role at a time instead of being handed the caller's role. Both
 * read the same canonical set, so a gate written either way admits exactly the
 * roles the API's admin gate admits.
 */
export function hasAdminRole(has: ClerkRoleCheck): boolean {
  return Object.values(OrgAdminRole).some((role) => has({ role }));
}
