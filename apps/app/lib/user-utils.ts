import type { User } from "@repo/design-system/components/ui/user-select-popover";

/**
 * Get display name from user object
 * Falls back to email if no name parts are available
 */
export function getUserDisplayName(user: {
  firstName: string | null;
  lastName: string | null;
  email?: string;
}): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return name || user.email || "Unknown user";
}

/**
 * Get initials from user's first and last name
 * Returns "?" if no initials can be generated
 */
export function getUserInitials(
  firstName: string | null,
  lastName: string | null
): string {
  const first = firstName?.charAt(0) ?? "";
  const last = lastName?.charAt(0) ?? "";
  return (first + last).toUpperCase();
}

/**
 * Get initials from a full name.
 */
export function getInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .join("")
    .toUpperCase()
    .slice(0, 2);
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
