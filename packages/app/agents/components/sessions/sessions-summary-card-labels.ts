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
 * card's is `TOTAL_ESTIMATED_COST_ALIAS_LABEL`
 * (`@repo/api/src/types/total-estimated-cost-copy`), ruling 7's short form of
 * the one dollar phrase, which this strip's card widths license and
 * `resolveCostCardPresentation` registers; the LOC/$ card's is
 * `LOC_PER_DOLLAR_LABEL`
 * (`@repo/api/src/utils/loc-per-dollar`), the one surviving unit constant after
 * ISS-9964 / ISS-9980 (RULED 2026-09-11) retired the `(Merged)` variant — the
 * Sessions ratio counts merged authored PRs everywhere now, so a qualifier
 * distinguishing it from the bare unit had nothing left to distinguish. Both
 * already have a canonical home, so re-declaring them here would be the drift
 * this module exists to prevent.
 */

export const SESSIONS_METRIC_CARD_LABEL = "Sessions";
/**
 * ISS-7175: the word is unchanged, but what it names was wrong until then. The
 * tile summed `input + output` only — DOC-15's `Uncached Tokens per Session` —
 * while calling itself "Total", so on a cache-heavy harness it understated by
 * roughly an order of magnitude and disagreed with the Session-detail row that
 * prints all four counters. The COMPUTATION moved to match the label rather than
 * the label to match the computation (`sessions-summary-cards.tsx`, plus the
 * server-side delta basis); this constant is the label both surfaces now share
 * with `SESSION_TOKENS_PROPERTY_LABEL` in `../detail/session-property-labels`.
 */
export const TOTAL_TOKENS_METRIC_CARD_LABEL = "Total Tokens";
export const PRS_SHIPPED_METRIC_CARD_LABEL = "PRs Shipped";
