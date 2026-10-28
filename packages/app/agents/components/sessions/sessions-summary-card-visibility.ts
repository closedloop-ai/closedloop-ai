import {
  LOC_METRIC_DEFINITION,
  LocMetricDefinitionId,
} from "@repo/api/src/types/loc-metric-definitions";
import { TOTAL_ESTIMATED_COST_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import { TOTAL_TOKENS_LABEL } from "@repo/api/src/types/total-tokens-copy";
import type { TableToggleOption } from "@repo/design-system/components/ui/table-toolbar-model";
import {
  PRS_SHIPPED_METRIC_CARD_LABEL,
  SESSIONS_METRIC_CARD_LABEL,
  TOTAL_TOKENS_METRIC_CARD_LABEL,
} from "./sessions-summary-card-labels";

/**
 * FEA-4217 — stable identity for each Sessions summary card, so a per-card
 * show/hide toggle keys off something the persistence layer can store.
 *
 * The cards are emitted as JSX literals, so before this they were identified
 * only by their display label. A persisted view keyed on a label would break the
 * moment the operator reworded one — and the Cost card does not even share a
 * label with its own menu row (see {@link SESSIONS_SUMMARY_CARD_LABELS}), so for
 * that card a label key would not identify one thing.
 */
export const SessionsSummaryCardId = {
  Sessions: "sessions",
  Tokens: "tokens",
  Cost: "cost",
  PrsShipped: "prs-shipped",
  LocPerDollar: "loc-per-dollar",
} as const;
export type SessionsSummaryCardId =
  (typeof SessionsSummaryCardId)[keyof typeof SessionsSummaryCardId];

/** Every card, in the order the strip paints them and the menu lists them. */
export const SESSIONS_SUMMARY_CARD_IDS: readonly SessionsSummaryCardId[] = [
  SessionsSummaryCardId.Sessions,
  SessionsSummaryCardId.Tokens,
  SessionsSummaryCardId.Cost,
  SessionsSummaryCardId.PrsShipped,
  SessionsSummaryCardId.LocPerDollar,
];

/**
 * The menu row label for each card, read from that card's own canonical label
 * constant rather than re-spelled here — a second spelling is how a menu row
 * ends up naming a card the strip calls something else.
 *
 * The LOC/$ entry deliberately takes a STABLE constant rather than the label the
 * strip resolved for the current payload: ISS-9978 made that card's label
 * basis-dependent, and a menu row that renamed itself as the data changed would
 * read as a different card appearing. The row keeps the registry's SHIPPED
 * label, which is what the card reads on every basis any deployed server states
 * today.
 * Whether it should instead track the resolved label is ISS-8900's question.
 *
 * The Cost row is the one place that principle is deliberately broken, and the
 * break is forced rather than chosen. Its CARD renders ruling 7's alias "Cost"
 * (`resolveCostCardPresentation`) because the canonical phrase plus its info
 * trigger will not fit on one line at this strip's card widths. This ROW cannot
 * follow it: the Options menu already carries the Cost COLUMN toggle under the
 * spec's own word "Cost", and two menu rows with one accessible name is the
 * collision `toolbar-options-menu-mounted.test.tsx` pins. The LOADING shell
 * states the CARD's word, not this one (`sessions-summary-cards-loading.tsx`).
 */
export const SESSIONS_SUMMARY_CARD_LABELS: Record<
  SessionsSummaryCardId,
  string
> = {
  [SessionsSummaryCardId.Sessions]: SESSIONS_METRIC_CARD_LABEL,
  [SessionsSummaryCardId.Tokens]: TOTAL_TOKENS_METRIC_CARD_LABEL,
  [SessionsSummaryCardId.Cost]: TOTAL_ESTIMATED_COST_LABEL,
  [SessionsSummaryCardId.PrsShipped]: PRS_SHIPPED_METRIC_CARD_LABEL,
  [SessionsSummaryCardId.LocPerDollar]:
    LOC_METRIC_DEFINITION[LocMetricDefinitionId.SessionMergedLoc].label,
};

/**
 * The toggle rows for the toolbar's Options menu, in strip order.
 *
 * Built from {@link SESSIONS_SUMMARY_CARD_IDS} rather than listed again, so a
 * card added to the strip cannot arrive without a way to hide it.
 */
export function sessionsSummaryCardOptions(
  labels: Readonly<
    Record<SessionsSummaryCardId, string>
  > = SESSIONS_SUMMARY_CARD_LABELS
): TableToggleOption[] {
  return SESSIONS_SUMMARY_CARD_IDS.map((id) => ({
    key: id,
    label: labels[id],
  }));
}

/**
 * Whether `id` is currently painted, given the persisted HIDDEN set.
 *
 * Visibility is stored as the hidden ids — the same direction `hiddenColumns`
 * uses — so a card added in a later build is visible for a reader whose stored
 * view predates it, instead of silently missing until they reset the view.
 */
export function isSummaryCardVisible(
  id: SessionsSummaryCardId,
  hiddenCardIds: ReadonlySet<string> | undefined
): boolean {
  return !hiddenCardIds?.has(id);
}

/**
 * The hidden set a host should hand the strip, given whether the menu that
 * hides cards is on this build at all.
 *
 * Gate-OFF must read as "nothing hidden", not as the stored set: a reader who
 * hid two cards while the gate was on would otherwise keep a short strip with no
 * control on screen that explains it. The stored set is preserved either way, so
 * turning the gate back on restores their choice rather than resetting it.
 *
 * A shared helper rather than a ternary at each host: both surfaces owe the same
 * answer, and inlining it put `SessionsView` over the cognitive-complexity gate.
 */
export function resolveVisibleHiddenCardIds(
  menuEnabled: boolean,
  hiddenCardIds: ReadonlySet<string>
): ReadonlySet<string> | undefined {
  return menuEnabled ? hiddenCardIds : undefined;
}

/**
 * The two cards whose numbers only exist for a signed-in cloud reader — the
 * delivery pair. They are the ONLY reason the strip ever asks for a sign-in, so
 * they are the population {@link hasVisibleDeliveryCard} answers over.
 */
export const SESSIONS_DELIVERY_SUMMARY_CARD_IDS: readonly SessionsSummaryCardId[] =
  [SessionsSummaryCardId.PrsShipped, SessionsSummaryCardId.LocPerDollar];

/**
 * Whether the strip still paints a card that needs a signed-in cloud read.
 *
 * The sign-in ask is a request for the DATA these two cards carry. A reader who
 * hid both and kept the always-available ones has removed everything the ask
 * would unlock, so a banner above that strip names metrics that are no longer on
 * screen (whitlockk review).
 */
export function hasVisibleDeliveryCard(
  hiddenCardIds: ReadonlySet<string> | undefined
): boolean {
  return SESSIONS_DELIVERY_SUMMARY_CARD_IDS.some((id) =>
    isSummaryCardVisible(id, hiddenCardIds)
  );
}

/**
 * Whether the reader has hidden the whole strip.
 *
 * Shared with the hosts, not just the strip: a host that keeps its padded,
 * sticky card band mounted around a strip that renders nothing leaves the same
 * unexplained empty band one level up (whitlockk review).
 */
export function areAllSummaryCardsHidden(
  hiddenCardIds: ReadonlySet<string> | undefined
): boolean {
  return (
    SESSIONS_SUMMARY_CARD_IDS.length > 0 &&
    SESSIONS_SUMMARY_CARD_IDS.every((id) => hiddenCardIds?.has(id))
  );
}

/**
 * Which summary cards are hidden, given the two places the answer can come
 * from. The reader's own toggle (view state) wins once it exists; until then a
 * host that persists hidden ids is still honoured, so supplying
 * `hiddenSummaryCards` does not silently stop working the moment the surface
 * grew view state of its own (FEA-4217).
 */
export function resolveHiddenSummaryCardIds(
  viewHiddenCardIds: ReadonlySet<string> | undefined,
  hostHiddenCardIds: ReadonlySet<string> | undefined
): ReadonlySet<string> {
  return viewHiddenCardIds ?? hostHiddenCardIds ?? EMPTY_HIDDEN_CARD_IDS;
}

/** Shared empty set, so a default never allocates per render. */
const EMPTY_HIDDEN_CARD_IDS: ReadonlySet<string> = new Set();

/**
 * ISS-7052 Part A: what the v2 surface's options menu and metric band each need
 * from one persisted HIDDEN set.
 *
 * Derived here, beside {@link areAllSummaryCardsHidden}, rather than in the
 * surface: the menu speaks VISIBLE keys while every host persists HIDDEN ones,
 * and doing that inversion at the render site is how a menu and the strip it
 * controls come to disagree about which card is on.
 */
export function resolveSummaryCardVisibility(
  hiddenCardIds: ReadonlySet<string> | undefined
): { visibleCardKeys: ReadonlySet<string>; allHidden: boolean } {
  return {
    visibleCardKeys: new Set(
      SESSIONS_SUMMARY_CARD_IDS.filter((cardId) => !hiddenCardIds?.has(cardId))
    ),
    allHidden: areAllSummaryCardsHidden(hiddenCardIds),
  };
}

/**
 * ISS-10667 (behind `ONE_LABEL_PER_METRIC_FLAG_KEY`): every row on its metric's
 * one label. Builds on the map above rather than beside it — ISS-10636 already
 * put the dollar row on the canonical phrase for every reader, so only the two
 * rows this gate still moves are re-stated here.
 *
 * The ratio row takes the MERGED label: the shipped spelling names the merged
 * basis on every basis a deployed server states today, which is the reason the
 * header above gives for this row holding a stable constant at all.
 */
export const ONE_LABEL_PER_METRIC_SESSIONS_SUMMARY_CARD_LABELS: Record<
  SessionsSummaryCardId,
  string
> = {
  ...SESSIONS_SUMMARY_CARD_LABELS,
  [SessionsSummaryCardId.Tokens]: TOTAL_TOKENS_LABEL,
  [SessionsSummaryCardId.LocPerDollar]:
    LOC_METRIC_DEFINITION[LocMetricDefinitionId.SessionMergedLoc]
      .canonicalLabel,
};
