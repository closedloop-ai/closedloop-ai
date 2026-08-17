/**
 * ISS-5574: the single cross-surface flag key that gates per-page browser tab
 * titles on the Sessions and Branches surfaces.
 *
 * Every Sessions and Branches page — both lists and both details, on web and in
 * the desktop renderer — reported the application-wide `"Closedloop.ai"`, so a
 * user with several tabs open could not tell a session from a branch, and
 * browser history and bookmarks were equally undifferentiated.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) precisely so BOTH surfaces import the SAME literal
 * instead of redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop renderer resolves the byte-for-byte-equal key from its Labs
 *    registry (`apps/desktop/src/shared/feature-flags.ts`).
 *
 * Importing one constant on both sides means a future rename touches a single
 * definition — it can't silently split PostHog and the Desktop Labs toggle the
 * way two parallel string literals could.
 */
export const SESSIONS_BRANCHES_TAB_TITLES_FLAG_KEY =
  "sessions-branches-tab-titles" as const;
