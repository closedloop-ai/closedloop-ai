/**
 * ISS-9971: the ONE phrase for a dollar figure, and the one explanation of it.
 *
 * Every surface that labels a dollar amount — the Dashboard KPI, the Insights
 * tiles and metric picker, the Branches summary strip, the Sessions summary
 * card and table column — resolves its label and tooltip from this map, which
 * ISS-10636 made unconditional. Nothing else may declare the phrase:
 * `packages/app/shared/lib/__tests__/total-estimated-cost-single-owner.test.ts`
 * fails on a second declaration anywhere a surface renders from.
 *
 * Lives in `@repo/api` rather than `@repo/app` so a producer that
 * wants to name the figure (a KPI `label`, a metric dictionary entry) can
 * import the same string the renderers do, and so a bundle-sensitive client
 * pays for nothing but two strings.
 */
export const TOTAL_ESTIMATED_COST_COPY = {
  label: "Total estimated cost",
  /**
   * ISS-10667 ruling 7: the ONE authorized short form, permitted only where the
   * canonical phrase measurably does not fit. A FIELD on this record rather than
   * a constant of its own, so the two forms cannot be renamed apart.
   *
   * Do not reach for this without a number. Every production use is registered
   * with its measurement in the ticket's alias-use register (and the register on
   * PR #7615), and NAMED here rather than counted — a count is a single
   * monotonic value two branches both rewrite, and git merges two edits to it
   * without a conflict, so the second to land is silently wrong. The register:
   *
   *  - `agents/lib/session-filter-adapter.tsx` — the Sessions filter facet.
   *  - `agents/components/detail/session-properties-panel.tsx` — the Session
   *    detail properties row.
   *  - `agents/components/sessions/cost-card-presentation.ts` — the Sessions
   *    summary strip's Cost card (operator ruling 2026-09-20). Measured in
   *    Chromium against the shipped primitive: the phrase's text advance is
   *    154.73px and the info trigger's is 26px, so the pair needs 180.73px of a
   *    label box that is `cardWidth - 34`. The trigger orphans onto a second
   *    line box for every card width at or below 208.4px, clearing at 208.8px.
   *    The desktop default window lays 207px cards (a 1099px track over five)
   *    and so does web at the 1380px viewport `sessions-table-legibility.spec.ts`
   *    pins; web at 1440 lays 215px and is clear, so this is the narrow shells'
   *    defect, not every shell's. Only ONE of those two line boxes holds text, so the
   *    row's derived reservation grows a blank line on every sibling card and
   *    the whole rank's values drop 16px.
   *  - `agents/components/sessions/sessions-summary-cards-loading.tsx` — the
   *    loading shell of that same card, on the same measurement. It has to state
   *    what the settled card will say or the label rewrites itself when the read
   *    lands (ISS-5366).
   *  - `agents/components/sessions/cost-metric-card.tsx` — `COST_METRIC_CARD_LABEL`,
   *    the card primitive's DEFAULT label, carrying no measurement of its own.
   *    It is bound to this field rather than re-typed so the short form has one
   *    declaration; every shipped caller passes its own label, so the default
   *    reaches a user only through a story or harness.
   *
   * Stories, harnesses and tests are outside this register: the single-owner
   * test excludes `.stories.`/`.test.` alongside `__tests__`, so a grep for the
   * constant finds more files than this register names.
   *
   * The Sessions Options-menu ROW for that card is deliberately NOT on this list
   * and keeps the canonical phrase: it shares one menu with a Cost COLUMN toggle
   * already called "Cost", and two menu rows under one accessible name is the
   * collision `toolbar-options-menu-mounted.test.tsx` pins.
   *
   * A candidate that measured its way OFF the list: ISS-10691's desktop
   * model-trend header was held back on a basis decision, and when that settled
   * the measurement put a 115px phrase in 1083px of shipped column, so it took
   * the canonical.
   */
  shortLabel: "Cost",
  info: {
    what: "Estimated cost of AI usage in the selected range, every billing type included.",
    how: "Each session's token usage is priced at its model's API rates and counted once per session, whether it was billed to an API key, covered by a subscription, or of unknown billing type. Usage that could not be priced is excluded, so the figure is an estimate rather than an invoice.",
  },
} as const;

export const TOTAL_ESTIMATED_COST_LABEL = TOTAL_ESTIMATED_COST_COPY.label;

export const TOTAL_ESTIMATED_COST_ALIAS_LABEL =
  TOTAL_ESTIMATED_COST_COPY.shortLabel;
