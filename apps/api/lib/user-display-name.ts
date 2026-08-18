/**
 * Single source of truth for deriving a backend user display name from name
 * parts. Previously hand-rolled (`[firstName, lastName].filter(Boolean).join(" ")`)
 * across a dozen apps/api services (FEA-3506); consolidated here so every
 * surface reads a user identically.
 */

/** The name-bearing shape shared by every caller (Prisma User selects, DTOs). */
type NamedUser = {
  firstName: string | null;
  lastName: string | null;
};

/**
 * Join a user's name parts into a single display string, dropping empty parts
 * and normalizing surrounding whitespace. Returns "" when no usable name part
 * exists, so callers can apply their own fallback (email, "Teammate", etc.).
 */
export function formatUserFullName(user: NamedUser): string {
  return [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
}

/**
 * Canonical backend display name: the user's full name, falling back to their
 * email when no name part is set.
 */
export function displayUserName(user: NamedUser & { email: string }): string {
  return formatUserFullName(user) || user.email;
}
