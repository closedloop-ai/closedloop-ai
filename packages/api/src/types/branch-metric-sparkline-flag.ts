/**
 * ISS-10363: the flag key gating the trend sparkline on the Branches listing
 * metric cards.
 *
 * ISS-10544 NARROWED WHAT IT GATES, without minting a second key. Per the
 * operator's ruling of 2026-09-17 the sparkline is GRADUATED on web — the web
 * Branches route answers `WEB_BRANCH_METRIC_SPARKLINE` with no key involved —
 * and this key is what the DESKTOP renderer still resolves, at the one read site
 * it has left, `useDesktopBranchMetricSparkline`. One key per gated surface; the
 * surface still gated is desktop's.
 *
 * On, a card whose producer supplied a series draws it in the delta slot instead
 * of dropping the mark because the SEPARATE comparison operand is missing; a
 * card with no series renders exactly what it ships today. Display only — the
 * series is folded from the same evidence and the same windows as the headline
 * figure, so no producer math, reconciliation, or wire shape changes with it.
 *
 * Closed by default on desktop (ISS-4779), and closed for a signed-out desktop
 * reader whatever PostHog says: `useDesktopPostHogFlagAssignment` settles an
 * account-less session to `flags: {}` and the provider's adapter reads
 * `flags[key] === true`. That is why the web half was graduated rather than
 * rolled out — a guest has no assignment to read.
 *
 * THE EXPORT'S NAME IS LOAD-BEARING, and that is why it ends `_FEATURE_FLAG_KEY`
 * (tamsinb review, PR #7525; operator ruling 2026-09-18 to keep the desktop
 * gate). `posthog-flag-registration-scan.ts` collects a declaration only when the
 * exported constant's name ends in `FLAG_KEY_EXPORT_SUFFIX`, and it walks
 * `packages/api/src` but excludes `apps/desktop` by design. Graduating the web
 * half moved the last gate site inside a scanned root into the desktop renderer,
 * so under the old `_FLAG_KEY` spelling this key fell out of
 * `collectRepoFlagKeyRegistry` entirely — measured at 218 keys with this one
 * absent — and `reconcileShippedKeys` skips anything the registry does not hold.
 * The desktop half would have stayed dark forever with the one mechanism that
 * nags about an uncreated flag no longer able to see it, while the ledger row
 * still read ACTION REQUIRED.
 *
 * So: the suffix is what registers the DECLARATION with no gate site needed, and
 * renaming this constant back would silently unregister the key rather than
 * break a build.
 */
export const BRANCH_METRIC_SPARKLINE_FEATURE_FLAG_KEY =
  "branches-metric-card-trend-sparkline" as const;
