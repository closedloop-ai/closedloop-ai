/**
 * Client-side role utilities.
 *
 * Mirrors the backend ADMIN_ROLES set in apps/api/lib/auth/org-admin.ts.
 * Both must be kept in sync.
 */

const ADMIN_ROLES = new Set(["org:admin", "org:owner"]);

/**
 * Check if a Clerk membership role has admin-level access.
 * Accepts both org:admin and org:owner, matching the backend.
 */
export function isAdminRole(role: string | undefined): boolean {
  return !!role && ADMIN_ROLES.has(role);
}
