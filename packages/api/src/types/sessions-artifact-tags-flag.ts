/**
 * ISS-8712 (ISS-4779 closed-by-default policy): the flag key gating the Sessions
 * list's `Tags` column — the org Tag vocabulary (the searchable picker and its
 * coloured tag pills) that PRDs and Issues already use, mounted on a session row
 * via the generic `TagArtifact` join. Default OFF.
 *
 * WEB-SIDE ONLY, by operator directive (2026-08-30): Labs toggles are
 * deprecated, so this key has no `apps/desktop` alias and the desktop registers
 * no toggle for it. The desktop renderer reads the same shared column
 * declaration through `useFeatureFlagEnabledOptional`, and resolves this SAME
 * key from the signed-in account's PostHog assignment — so both surfaces follow
 * one assignment rather than a second gate that could drift out of step with
 * this one.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so the `"use client"` Sessions table can import the
 * literal without pulling a parser in, matching its sibling flag-key modules.
 */
export const SESSIONS_ARTIFACT_TAGS_FLAG_KEY =
  "sessions-artifact-tags" as const;
