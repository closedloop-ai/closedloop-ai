/**
 * ISS-10598 (ISS-4779 closed-by-default policy): the flag key gating the
 * Session Timeline's colour key. Default OFF.
 *
 * The strip's bar colours and dot colours both carry meaning with nothing on
 * screen naming it. The key that fixes that is new, perceivable UI on a shipped
 * surface, so it ships shut and opens on one decision.
 *
 * WEB AND DESKTOP OFF THIS ONE KEY. The desktop renderer mounts the SAME shared
 * `AgentSessionDetailView` and resolves this SAME key from the signed-in
 * PostHog assignment its provider already holds (`DesktopFeatureFlagProvider`),
 * which fails closed on every unresolved key — so both shells flip together
 * rather than off a second gate that could drift out of step with this one.
 * There is no `apps/desktop` registry alias for it, by the AGENTS.md rule that
 * retired the local-registry cutover.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so the `"use client"` timeline strip can import the
 * literal without pulling a parser in, matching its sibling flag-key modules.
 */
export const SESSION_TIMELINE_LEGEND_FLAG_KEY =
  "session-timeline-legend" as const;
