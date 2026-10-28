/**
 * The single cross-surface flag key gating keyboard focus restoration on the
 * Sessions list (ISS-9555, PLN-1950 slice 6).
 *
 * ## What it gates
 *
 * Two behaviours, which are one feature: where the reader's keyboard is after
 * the rows underneath it are replaced.
 *  - A PAGE TURN removes every cell, so a focused cell's focus falls to
 *    `<body>` and the reader has to tab in from the top of the document again.
 *    Open, the grid takes focus back to its own entry cell.
 *  - RETURNING to the list after opening a session leaves the grid with no
 *    remembered roving cell, so its tab stop resets to the first row. Open, the
 *    tab stop resumes on the row that was opened — and only while that row is
 *    still rendered, so the grid's staleness guard keeps governing.
 *
 * ONE key rather than two, because they are the same promise to the same
 * reader: a build where a page turn kept focus but a return did not is a
 * rollout shape nobody designed. Closed, both are absent and the grid behaves
 * exactly as it did before.
 *
 * ## Why one key covers both shells
 *
 * `apps/app` and the desktop renderer mount the SAME
 * `SessionsListSurfaceV2`, which reads this key once through
 * `useFeatureFlagEnabledOptional`. The desktop renderer resolves the signed-in
 * account's PostHog assignment from the same key space `apps/app` reads, so
 * there is no desktop Labs toggle to pair with this key and no desktop registry
 * entry to add — the retired ISS-8024 `desktopPosthogFlags` cutover is what a
 * second entry would have been for.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module so the literal
 * is declared once and aliased rather than retyped. The one alias that resolves
 * to it is `SESSIONS_FOCUS_RESTORATION_FEATURE_FLAG_KEY`
 * (`packages/app/shared/lib/feature-flags.ts`), which is the read site both
 * shells reach.
 */
export const SESSIONS_FOCUS_RESTORATION_FLAG_KEY =
  "sessions-focus-restoration" as const;
