/**
 * Pure helpers for @-mentioning organization members in any inline comment
 * composer (FEA-3490). The "First Last / email" name derivation and the
 * name-or-email substring match are shared with the Liveblocks mention resolvers
 * (`packages/collaboration/client/user-resolvers.ts`) via the SDK-free
 * `@repo/collaboration/shared/mention-matching` module, so every surface applies
 * identical rules without maintaining two copies and without pulling in the
 * collaboration SDK.
 *
 * Canonical home for the mention text model (FEA-3490 follow-up): consumed by the
 * shared `MentionComposer` and by every comment rail that renders @-chips. Shared
 * by web and desktop via `@repo/app`; kept dependency-free and framework-agnostic
 * so it is trivially unit-testable on both surfaces.
 */

import {
  mentionMatchDisplayName,
  mentionQueryMatchesUser,
} from "@repo/collaboration/shared/mention-matching";

/** Matches any whitespace char; used to close/validate an "@query" token. */
const WHITESPACE_PATTERN = /\s/;

/** Minimal member shape the mention helpers need (a subset of `User`). */
export type MentionUser = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  avatarUrl?: string | null;
  active: boolean;
};

/**
 * Display name for a member: "First Last", falling back to email when no name
 * parts are set. Delegates to the shared, SDK-free name derivation so it stays
 * identical to the Liveblocks `createResolveUsers` behavior.
 */
export function mentionDisplayName(user: {
  firstName: string | null;
  lastName: string | null;
  email: string;
}): string {
  return mentionMatchDisplayName(user);
}

/**
 * Filters active org members by a mention query, matching name or email
 * (case-insensitive). Empty query returns all active members. Uses the shared
 * matching rule so it stays identical to `createResolveMentionSuggestions`.
 */
export function filterMentionCandidates<T extends MentionUser>(
  users: readonly T[],
  query: string
): T[] {
  return users.filter(
    (user) => user.active && mentionQueryMatchesUser(user, query)
  );
}

/**
 * Resolves a persisted mention user-ID to a display label. Unknown IDs (e.g. a
 * removed member, or a stale cached mention) resolve to a short generic label
 * so the chip still renders honestly rather than leaking a raw id.
 */
export function resolveMentionLabel(
  userId: string,
  usersById: ReadonlyMap<string, MentionUser>
): string {
  const user = usersById.get(userId);
  return user ? mentionDisplayName(user) : "Unknown user";
}

/**
 * Detects an in-progress "@query" token immediately before the caret. Returns
 * the token's start index and the query text (the run of non-whitespace chars
 * after the "@"), or null when the caret is not inside a mention token. The "@"
 * must start the input or follow whitespace so mid-word "@" (emails, handles in
 * prose) does not trigger the picker.
 */
export function findActiveMentionQuery(
  value: string,
  caret: number
): { start: number; query: string } | null {
  const upToCaret = value.slice(0, caret);
  const at = upToCaret.lastIndexOf("@");
  if (at < 0) {
    return null;
  }
  const query = upToCaret.slice(at + 1);
  // The query is the contiguous run after "@"; whitespace closes the token.
  if (WHITESPACE_PATTERN.test(query)) {
    return null;
  }
  const charBefore = at > 0 ? upToCaret[at - 1] : "";
  if (charBefore && !WHITESPACE_PATTERN.test(charBefore)) {
    return null;
  }
  return { start: at, query };
}

/**
 * Replaces the active "@query" token at `start..caret` with "@Display Name "
 * (trailing space) and returns the new text plus the caret position after the
 * inserted mention. The label is the resolved display name so the textarea shows
 * a human-readable token; the stable user ID is tracked separately as a mention.
 */
export function applyMentionSelection(input: {
  value: string;
  caret: number;
  start: number;
  label: string;
}): { value: string; caret: number } {
  const { value, caret, start, label } = input;
  const before = value.slice(0, start);
  const after = value.slice(caret);
  const inserted = `@${label} `;
  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}

/**
 * Given the mention IDs already persisted on a comment plus a directory of known
 * members, returns the subset of members to seed an editing composer with, so an
 * edit preserves existing @-mentions instead of silently clearing them. Unknown
 * IDs (removed/stale members) are dropped — they can no longer be re-inserted as
 * a live token, and the server re-scopes on write regardless.
 */
export function seedMentionsFromIds(
  userIds: readonly string[],
  usersById: ReadonlyMap<string, MentionUser>
): MentionUser[] {
  const seeded: MentionUser[] = [];
  for (const id of userIds) {
    const user = usersById.get(id);
    if (user) {
      seeded.push(user);
    }
  }
  return seeded;
}
