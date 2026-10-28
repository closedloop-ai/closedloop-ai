/**
 * ISS-8727 (ISS-4779 closed-by-default policy): the flag key gating the Session
 * Timeline reach box following the RESOLVED jump rather than the transcript
 * anchor alone. Default OFF.
 *
 * `getBucketReachClass` grants the full-column hit area on `tl0 != null`, which
 * asks whether the bucket HAS an anchor, not whether a click on it can land.
 * `getBucketJumpBlock` answers the second question, and on a partial or
 * `subagent:{id}` transcript it returns `NotInReadTranscript` for a bucket that
 * has an anchor the rendered trace does not cover — so one bar wore the
 * column-tall target, `.no-jump` and `aria-disabled` at once, and a click on it
 * did nothing. With this on, the enlarged target and the withdrawn affordance
 * can no longer co-occur; with it off the predicate is exactly today's.
 *
 * WEB-SIDE ONLY, by operator directive (2026-08-30): Labs toggles are
 * deprecated, so this key has no `apps/desktop` alias and the desktop registers
 * no toggle for it. The desktop renderer mounts the SAME shared
 * `AgentSessionDetailView` and resolves this SAME key from the signed-in
 * PostHog assignment its provider already holds
 * (`DesktopFeatureFlagProvider`), which fails closed on every unknown or
 * unresolved key — so both surfaces flip together off one answer rather than
 * off a second gate that could drift out of step with this one.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so the `"use client"` timeline strip can import the
 * literal without pulling a parser in, matching its sibling flag-key modules.
 */
export const SESSION_TIMELINE_RESOLVABLE_REACH_FLAG_KEY =
  "session-timeline-resolvable-reach" as const;
