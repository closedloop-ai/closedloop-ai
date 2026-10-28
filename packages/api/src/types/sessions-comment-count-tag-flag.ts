/**
 * FEA-4204 (ISS-4779 closed-by-default policy): the single cross-surface flag
 * key gating the comment-count tag in the Sessions list's lead cell — a
 * `CountCell` reading "💬 3" beside the session name, rendered only for a
 * session that actually carries ClosedLoop trace comments. Default OFF: with it
 * off the lead cell stays the session name and nothing else, which is what
 * ISS-5666 / ISS-5770 deliberately cleared it to.
 *
 * Gated on both surfaces because the Sessions list exists on both and renders
 * from ONE shared component (`SyncedSessionsTable`), so an ungated tag would
 * appear everywhere at once. Display only — the `commentCount` the tag reads is
 * projected by the list API regardless of this flag.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so BOTH surfaces import the SAME literal instead of
 * redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `SESSIONS_COMMENT_COUNT_TAG_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop renderer resolves the byte-for-byte-equal key from the
 *    signed-in account's PostHog assignment, delivered over the IPC bridge,
 *    under the alias `DESKTOP_SESSIONS_COMMENT_COUNT_TAG_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags-labs-surfaces.ts`).
 *
 * Importing one constant on both sides means a future rename touches a single
 * definition — it can't silently split the two surfaces' reads of it the way
 * two parallel string literals could. The desktop parity test asserts each
 * surface alias resolves to this constant.
 */
export const SESSIONS_COMMENT_COUNT_TAG_FLAG_KEY =
  "sessions-comment-count-tag" as const;
