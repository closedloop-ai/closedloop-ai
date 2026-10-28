/**
 * ISS-9619 (ISS-4779 closed-by-default): the single cross-surface flag key
 * gating the `Local | UTC` day-boundary control on the Sessions and Branches
 * filter bars.
 *
 * The date-range windows both lists read over are UTC calendar days
 * (`getStableUtcDateWindowForRange`), which is right for a stable query key and
 * for period-over-period comparison but means the visible "day" boundary is
 * UTC rather than the reader's own. This key gates the control that lets them
 * choose. DEFAULT OFF, and the mode itself defaults to UTC, so with the gate
 * shut every window is byte-identical to what ships today.
 *
 * ONE key for both shells, per the 2026-08-30 operator directive and
 * `packages/app/AGENTS.md`: the desktop renderer resolves the signed-in
 * account's PostHog assignment from the same key space `apps/app` reads, so
 * there is no desktop Labs toggle to pair with this key and no desktop
 * flag-registry shadow entry to add. The retired ISS-8024 cutover key
 * (`desktopPosthogFlags`) no longer selects a local registry path, so a shared
 * PostHog key must not get one.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so a `"use client"` surface can import the literal
 * without pulling a parser in, matching its sibling flag-key modules.
 */
export const SESSIONS_BRANCHES_TIMEZONE_MODE_FLAG_KEY =
  "sessions-branches-timezone-mode" as const;
