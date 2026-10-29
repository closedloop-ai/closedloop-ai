/**
 * ISS-8510: the single cross-surface flag key gating the Branches List summary
 * cards' honest never-loaded state. When the approved metric bundle is still
 * absent with no error, the cards keep their labels and info chrome but skeleton
 * only the value slot instead of borrowing the failed-read em dash. Display only;
 * held metric bundles, producer math, reconciliation, and wire shapes are
 * unchanged.
 *
 * Lives in this lightweight `@repo/api` module so the web PostHog alias and the
 * Desktop Labs alias resolve to the same literal instead of parallel strings.
 */
export const BRANCHES_SUMMARY_HONEST_LOADING_FLAG_KEY =
  "branches-summary-honest-loading" as const;
