/**
 * Desktop-main single source of truth for deriving a user display name from
 * name parts. This is a deliberate desktop-local copy of the cloud SSOT
 * (`apps/api/lib/user-display-name.ts`) — same precedent as `numberOrZero` in
 * `database/db-helpers.ts` — because desktop-main cannot take a runtime value
 * import from `@repo/api` (pglite boot caveat, FEA-3606). The name-part collapse
 * and email fallback are kept contract-identical to the cloud so every surface
 * reads a user the same way.
 */

/** The name-bearing shape shared by every caller (org-directory `BasicUser`). */
type NamedUser = {
  firstName: string | null;
  lastName: string | null;
};

/**
 * Join a user's name parts into a single display string, dropping empty parts
 * and normalizing surrounding whitespace. Returns "" when no usable name part
 * exists so callers can apply their own fallback (email, …). Contract-identical
 * to the cloud `formatUserFullName`, including the trailing `.trim()`.
 */
export function formatUserFullName(user: NamedUser): string {
  return [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
}

/**
 * Canonical desktop-main display name: the user's full name, falling back to
 * their email when no name part is set. Mirrors the cloud `displayUserName`.
 */
export function displayUserName(user: NamedUser & { email: string }): string {
  return formatUserFullName(user) || user.email;
}
