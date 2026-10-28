/**
 * ISS-9692 (ISS-4779 closed-by-default policy): the flag key gating the
 * EXTENDED rows-per-page ladder — the 250 and 500 entries offered alongside the
 * 25 / 50 / 100 every list surface has always shipped. Default OFF.
 *
 * ONE key for every list surface, deliberately. The ladder is a single shared
 * control rendered by one design-system component; three per-surface keys would
 * let Sessions offer 500 while Branches did not, which is exactly the
 * inconsistency the shared ladder exists to prevent. The server caps are raised
 * UNCONDITIONALLY (see `TABLE_PAGE_SIZE_MAX`) because a cap is not perceivable
 * UI and a flag-off client never asks for a size it cannot select — gating the
 * server on a client-resolved flag would 400 the very request the flag allowed.
 *
 * WEB-SIDE ONLY, by operator directive (2026-08-30): Labs toggles are
 * deprecated, so this key has no `apps/desktop` alias and the desktop registers
 * no toggle for it. The desktop renderer mounts the SAME shared surfaces and
 * reads this SAME key through `useFeatureFlagEnabledOptional`, so the two
 * platforms resolve one assignment rather than two gates that can drift.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so a `"use client"` list surface can import the
 * literal without pulling a parser in, matching its sibling flag-key modules.
 */
export const TABLE_PAGE_SIZE_LADDER_FLAG_KEY =
  "table-page-size-ladder" as const;
