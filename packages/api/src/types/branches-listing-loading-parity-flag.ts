/**
 * ISS-10645: the single cross-surface flag key gating the Branches listing's
 * loading treatment being the SAME one the Sessions listing already ships —
 * the shared spinner → slow → unavailable ladder in the table region, the
 * account CTA the operator asked the stalled state to offer, and labelled
 * summary cards in place of anonymous grey blocks.
 *
 * Display only: no query, producer math, reconciliation, or wire shape changes
 * with it. Lives in this lightweight `@repo/api` module so every surface that
 * gates on it resolves the same literal instead of a parallel string.
 */
export const BRANCHES_LISTING_LOADING_PARITY_FLAG_KEY =
  "branches-listing-loading-parity" as const;
