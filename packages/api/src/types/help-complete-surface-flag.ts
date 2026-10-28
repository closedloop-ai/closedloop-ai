/**
 * PRD-730 `batch-fs-settings-utility` (ISS-4779 closed-by-default): the single
 * cross-surface key gating Help's move to complete-surface ownership.
 *
 * OFF — the default — the route keeps the composition PRD-555 shipped, with the
 * shell owning the two-pane layout and the state ladder. ON, it mounts
 * `HelpSurfaceV2`, which owns those outright and takes only host-boundary seams.
 * The perceivable difference is the MALFORMED render the superseded body has no
 * branch for, which is why it ships shut.
 *
 * Lives in this dependency-free `@repo/api` module so every shell imports the
 * SAME literal. Since ISS-8753 the desktop renderer resolves the account's
 * PostHog assignment and nothing else, so there is no desktop alias, no Labs
 * toggle and no registry entry beside it (operator directive, 2026-08-30).
 *
 * Deliberately NOT `docsHelp`: that key gates whether the Help DESTINATION
 * exists on this build, and keeps doing exactly that. Retiring it would remove
 * reachable capability — a product decision, so it is untouched.
 */
export const HELP_COMPLETE_SURFACE_FLAG_KEY = "help-complete-surface" as const;
