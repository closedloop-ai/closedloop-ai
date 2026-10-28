/**
 * Session-detail labels that more than one file has to agree on. Deliberately a
 * ZERO-IMPORT constants module, not an export off a component: the rows, the
 * label-order contract, and both shells' Playwright specs read these, and
 * `e2e/**` keeps its shared imports on modules that pull nothing behind them.
 *
 * Only labels with that problem live here. The panel's other rows ("Status",
 * "Owner", "Harness", ...) are still inline strings, because a plain noun nobody
 * is tempted to re-derive has nothing to drift against.
 */

/**
 * ISS-7175 (Cosimo, 2026-08-22): the Properties row keeps the PLAIN noun.
 *
 * The row renders `tokensIn | tokensOut | cache read | cache write` — the four
 * counters broken out, never their sum. An earlier cut of this ticket renamed it
 * "Total Tokens" to match the Sessions-list tile, which put the word "Total" on
 * the one element on the screen that does not show a total, and left the element
 * that DOES show it — the Session Timeline strip beside this panel — under a bare
 * unit word. That is the same inversion the ticket exists to close, rebuilt
 * inside one screen, so the decision went the other way: the parts keep the plain
 * noun, and the total's name goes to the fact that reports the total.
 */
export const SESSION_TOKENS_PROPERTY_LABEL = "Tokens";

/**
 * The unit word under the Session Timeline strip's token fact — the element that
 * DOES sum all four counters (`sumSessionTokens` in `session-timeline-summary`),
 * through the same `formatTokenCount` as the Sessions-list "Total Tokens" tile.
 *
 * Named so the strip states which of DOC-15's two sums it is showing, and states
 * the same one as that tile. Lower-case because it is a unit beside a figure
 * ("9.20M total tokens"), not a column heading; `TOTAL_TOKENS_METRIC_CARD_LABEL`
 * is the title-case tile label naming the identical quantity. The two are
 * separate literals rather than one shared constant for the loader reason in the
 * header above, and `token-metric-label-pair.test.tsx` pins both texts so a
 * one-sided rename fails CI.
 */
export const SESSION_TIMELINE_TOTAL_TOKENS_UNIT = "total tokens";

/**
 * PLN-2061 M5: the row naming repositories the org does not track that the
 * session touched. OPERATOR RULING 2026-09-22 (Kerensa Whitlock): the label is exactly
 * this string.
 */
export const SESSION_OTHER_REPOSITORIES_PROPERTY_LABEL = "Other repositories";
