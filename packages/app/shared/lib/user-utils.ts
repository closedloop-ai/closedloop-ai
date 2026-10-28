import { mentionMatchDisplayName } from "@repo/collaboration/shared/mention-matching";
import type { User } from "@repo/design-system/components/ui/user-select-popover";

/**
 * Join a user's name parts into a single "First Last" string, dropping empty
 * parts. Returns "" when no usable name part exists so callers can apply their
 * own fallback chain (email, id, "—", …).
 *
 * SSOT for the renderer-surface name-part collapse (FEA-3606) — the desktop
 * account tab used to inline this exact expression. NOTE: this intentionally
 * does NOT `.trim()` the joined result, preserving that inlined derivation
 * byte-for-byte: a whitespace-only name part is returned as-is rather than
 * collapsed to "". The backend counterpart
 * (`apps/api/lib/user-display-name.ts` `formatUserFullName`) DOES trim; the two
 * are deliberately kept separate because their observable outputs differ on
 * whitespace-only inputs and desktop-main cannot take a runtime value import
 * from `@repo/api` (pglite boot caveat) anyway.
 */
export function getUserNamePart(user: {
  firstName: string | null;
  lastName: string | null;
}): string {
  return [user.firstName, user.lastName].filter(Boolean).join(" ");
}

/**
 * Get display name from user object
 * Falls back to email if no name parts are available
 *
 * Delegates the "First Last / email" derivation to the shared, SDK-free
 * `@repo/collaboration/shared/mention-matching` helper so it stays identical to
 * the mention resolvers (FEA-3507). The mention copy treats email as required,
 * so we normalize the optional email to "" and keep the extra "Unknown user"
 * fallback here.
 */
export function getUserDisplayName(user: {
  firstName: string | null;
  lastName: string | null;
  email?: string;
}): string {
  return (
    mentionMatchDisplayName({ ...user, email: user.email ?? "" }) ||
    "Unknown user"
  );
}

/**
 * Get initials from user's first and last name
 * Returns an empty string if no initials can be generated
 */
export function getUserInitials(
  firstName: string | null,
  lastName: string | null
): string {
  // One initial on every avatar (Nerys, 2026-10-22): the first name's, or the
  // last name's when there is no first.
  return (firstName?.charAt(0) || lastName?.charAt(0) || "").toUpperCase();
}

/**
 * An avatar's initial: the name's first letter (one initial on every avatar,
 * Nerys 2026-10-22).
 */
export function getInitials(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : "";
}

type ComparableAssignee = {
  firstName: string | null;
  lastName: string | null;
  email?: string;
};

/**
 * Compare two assignees by display name. Null/undefined assignees sort to the
 * end so "unassigned" rows appear last under ascending order.
 */
export function compareAssigneeNames(
  a: ComparableAssignee | null | undefined,
  b: ComparableAssignee | null | undefined
): number {
  if (!(a || b)) {
    return 0;
  }
  if (!a) {
    return 1;
  }
  if (!b) {
    return -1;
  }
  return getUserDisplayName(a).localeCompare(getUserDisplayName(b));
}

/**
 * Transform API User to UserSelectPopover User format
 * Handles null avatarUrl (converts to undefined) and missing names (fallback to email)
 */
export function transformApiUserToSelectUser(user: {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email?: string;
  avatarUrl?: string | null;
}): User {
  return {
    id: user.id,
    name: getUserDisplayName(user),
    email: user.email,
    avatarUrl: user.avatarUrl ?? undefined,
    initials: getUserInitials(user.firstName, user.lastName),
  };
}

/**
 * The word an artifact surface shows when nobody is assigned. ISS-7746 made it
 * the assignee avatar's accessible name too, so it is no longer only a label a
 * sighted user reads: it is also what a screen reader speaks, and the two must
 * not diverge.
 *
 * Domain-side SSOT for the artifact-assignee and session-owner surfaces that
 * `apps/app` and the desktop renderer mount (ISS-10249). Two copies of the word
 * sit outside it: the generic-artifact preview under
 * `shared/components/generic-artifact-surface/preview/`, which only
 * `apps/prototypes` mounts, and
 * `packages/design-system/components/ui/filter-popover*.tsx`, which is gated
 * from importing `@repo/app`.
 */
export const UNASSIGNED_ASSIGNEE_LABEL = "Unassigned" as const;
