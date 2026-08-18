/**
 * The Sessions summary strip's fixed card labels.
 *
 * These used to be inline string literals at each `MetricCard` call site, which
 * was fine while only one place rendered them. ISS-5366 gave the strip's LOADING
 * state real card shells (see `sessions-summary-cards-loading.tsx`) so the
 * skeleton is the card rather than a hardcoded-height slab, and that makes every
 * label a value TWO renders have to agree on — a drift between them would settle
 * the row the moment the data landed, which is the defect that change fixes.
 *
 * Deliberately a zero-dependency constants module, not an export off the
 * component: the loading row and the settled row both import it, and hanging
 * these off either one would make the other import a component runtime to read a
 * string (and, between those two files, a cycle).
 *
 * The other two labels the strip renders are NOT here on purpose. The Cost
 * card's is `SESSIONS_COST_METRIC_CARD_LABEL` (`cost-metric-card.tsx`), which
 * the org Dashboard shares; the LOC/$ card's is picked at runtime between
 * `LOC_PER_DOLLAR_LABEL` and `LOC_PER_DOLLAR_MERGED_LABEL`
 * (`@repo/api/src/utils/loc-per-dollar`). Both already have a canonical home, so
 * re-declaring them here would be the drift this module exists to prevent.
 */

export const SESSIONS_METRIC_CARD_LABEL = "Sessions";
export const TOTAL_TOKENS_METRIC_CARD_LABEL = "Total Tokens";
export const PRS_SHIPPED_METRIC_CARD_LABEL = "PRs Shipped";
