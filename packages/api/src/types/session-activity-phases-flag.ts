/**
 * ISS-5841: the single cross-surface flag key gating ACTIVITY PHASES on the
 * Session detail page — both the phases strip between Properties and the
 * Activity breakdown, and the "Activity phase" cut in the Timeline's Group-by
 * control (`TimelineStackGrouping.ActivityPhase`, ISS-5819).
 *
 * ONE key for both because they are one capability seen twice. Rolled
 * separately the page contradicts itself: a Group-by menu still offering to
 * re-cut the timeline by a phase model the page no longer shows anywhere, or a
 * phases strip with no way to see the same cut on the chart.
 *
 * SUPERSEDES FEA-3906, which asked to delete the phases breakdown outright.
 * Product's position is that the `plan`/`explore`/`implement` framing is how an
 * engineer thinks about working with AI, not how a PM or exec reasons about
 * cost, and that phase cost analysis belongs on the Branch screen. Gating it off
 * reaches the same user-visible outcome and is reversible, which deletion is
 * not — so this is a flag, not a `git rm`.
 *
 * Deliberately NOT folded into the `sessions-detail-prototype-parity` key
 * (ISS-5818/ISS-5819/ISS-5970), which gated CONFORMANCE work — the status chip,
 * region order, heading semantics, timeline controls — and was retired to its
 * enabled state by ISS-5999. This is a different intent: a capability toggle
 * for a production-only region with no prototype counterpart (ISS-5593 drift
 * inventory, row 28). Had they shared one key, phases would have graduated with
 * that re-layout instead of staying independently switchable.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so both surfaces import the SAME literal instead of
 * redeclaring it:
 *  - the web app resolves it per-viewer through PostHog, via
 *    `SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`);
 *  - the desktop main process registers it as a Labs toggle via
 *    `DESKTOP_SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags.ts`), which the packaged renderer
 *    resolves through `getAllFlags` because it has no PostHog wiring.
 *
 * `AgentSessionDetailView` mounts on BOTH surfaces, so one constant per side
 * means a rename touches a single definition and cannot silently split PostHog
 * from the Desktop toggle, leaving phases visible on one surface and hidden on
 * the other. Default OFF on both (ISS-4779 closed-by-default).
 */
export const SESSION_ACTIVITY_PHASES_FLAG_KEY =
  "session-activity-phases" as const;
