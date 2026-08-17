/**
 * SDK-free primitives for @-mention name derivation and text matching, shared
 * by the Liveblocks client resolvers (`client/user-resolvers.ts`) and the
 * dependency-free trace-comment mention helpers (`@repo/app/agents/lib/
 * trace-mentions.ts`). Kept here in `shared/` — free of any Liveblocks import —
 * so both the web collaboration layer and the desktop renderer can consume the
 * same matching/name rules without duplicating them (FEA-3490).
 */

/** Minimal member fields the mention name/match helpers read. */
export type MentionMatchUser = {
  firstName: string | null;
  lastName: string | null;
  email: string;
};

/**
 * Display name for a member: "First Last", falling back to email when no name
 * parts are set.
 */
export function mentionMatchDisplayName(user: MentionMatchUser): string {
  const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
  return name || user.email;
}

/**
 * Whether a member matches a mention query by name or email (case-insensitive
 * substring). An empty/whitespace query matches every member (callers use this
 * to show all suggestions before the user types).
 */
export function mentionQueryMatchesUser(
  user: MentionMatchUser,
  query: string
): boolean {
  const search = query.trim().toLowerCase();
  if (!search) {
    return true;
  }
  const fullName =
    `${user.firstName ?? ""} ${user.lastName ?? ""}`.toLowerCase();
  return fullName.includes(search) || user.email.toLowerCase().includes(search);
}
