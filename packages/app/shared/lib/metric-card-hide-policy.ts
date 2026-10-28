/**
 * One card the `metric-card-hide-unavailable` gate is deciding about.
 *
 * `notComputable` is the ROW's answer, not the primitive's: `MetricCard` can see
 * that a value is nullish, but only the row knows whether that nullishness is a
 * value nobody could compute, a read that failed, a gate the reader can open, or
 * an answer like `N/A`. Deciding it here is what stops the hide from swallowing
 * the other three (ISS-9730).
 */
export type MetricCardHideCandidate<TId> = {
  id: TId;
  notComputable: boolean;
};

/**
 * ISS-9749, closing ISS-9730 acceptance 3: what a summary row does when the gate
 * would retire EVERY card in it.
 *
 * THE DECISION IS ALL-OR-NOTHING. A row sheds its not-computable cards only
 * while at least one card survives. A row where every card is not computable
 * renders exactly as it does today, so an empty strip is never reachable while
 * this gate is open.
 *
 * The alternatives were an empty-state line and a collapsed region, and both are
 * new UI that buys blank space by giving something up. The gate-off row is the
 * only thing on screen naming which metrics this surface offers at all, and each
 * of its cards captions why it has no value; a reader who meets a corpus with
 * nothing computable is exactly the reader who needs that. Whether a designed
 * zero-card state should eventually replace it is a product question ISS-9749
 * escalates rather than answers — this rule is what keeps that escalation cheap,
 * because nothing ships a bare gap in the meantime.
 *
 * DO NOT CONFUSE THIS WITH THE SESSIONS STRIP. There, `areAllSummaryCardsHidden`
 * DOES collapse the band, because that set is the reader's OWN toggle: someone
 * who turned every card off asked for the space back. This set is gate-derived —
 * the reader never asked for anything — so the same collapse would take the row
 * away from the one person who most needs to see what the surface offers, and
 * (davetho on #6885) leaves the host's padded metric band wrapped around
 * nothing, which is a blank strip rather than a saving.
 *
 * Hiding is therefore never total, which is also why no caller grows a row-level
 * empty branch: a row's card count is either unchanged or at least one.
 */
export function hiddenMetricCardIds<TId>({
  cards,
  enabled,
}: {
  cards: readonly MetricCardHideCandidate<TId>[];
  enabled: boolean;
}): ReadonlySet<TId> {
  if (!enabled) {
    return new Set();
  }
  const hidden = cards.filter((card) => card.notComputable);
  if (hidden.length === cards.length) {
    return new Set();
  }
  return new Set(hidden.map((card) => card.id));
}
