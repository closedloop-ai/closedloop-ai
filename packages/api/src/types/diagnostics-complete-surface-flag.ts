/**
 * PRD-730 `batch-fs-settings-utility` (ISS-4779 closed-by-default): the single
 * cross-surface key gating Diagnostics' move to complete-surface ownership.
 *
 * The two shells read this ONE key for different decisions, and a reader who
 * takes either for the whole contract gets the other wrong. On DESKTOP, OFF
 * keeps the composition that ships today, with the shell owning the tab strip,
 * the state ladder and the page chrome; ON mounts `DiagnosticsSurfaceV2`, which
 * owns those outright and takes only host-boundary seams. The perceivable
 * difference is the per-section MALFORMED render the superseded body has no
 * branch for, which is why it ships shut. On WEB there is no superseded body to
 * fall back to: ISS-10006 shipped the route already gated, so OFF is a 404 and
 * ON is the only state in which the page exists at all.
 *
 * Lives in this dependency-free `@repo/api` module so every shell imports the
 * SAME literal. BOTH shells mount it today — `apps/desktop` since ISS-10004 and
 * `apps/app` since ISS-10006 — so one change to this key's PostHog rollout moves
 * both. Since ISS-8753 the desktop renderer resolves the account's PostHog
 * assignment and nothing else, so there is no desktop alias, no Labs toggle and
 * no flag-registry entry beside this key (operator directive, 2026-08-30).
 *
 * Deliberately NOT the two Labs keys already on this page
 * (`opencode-withheld-diagnostics`, `activity-coverage-diagnostics`): those gate
 * which SECTIONS a device offers, this one gates which COMPONENT the route
 * mounts.
 */
export const DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY =
  "diagnostics-complete-surface" as const;
