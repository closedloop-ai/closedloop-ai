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
