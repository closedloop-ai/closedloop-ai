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
  return name || user.email || "Unknown";
}

/**
 * Get initials from user's first and last name
 * Returns "?" if no initials can be generated
 */
export function getUserInitials(
  firstName: string | null,
  lastName: string | null
): string {
  const first = firstName?.charAt(0) || "";
  const last = lastName?.charAt(0) || "";
  return (first + last).toUpperCase() || "?";
}
