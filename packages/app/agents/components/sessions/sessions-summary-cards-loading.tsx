"use client";

import { TOTAL_ESTIMATED_COST_ALIAS_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import { SummaryMetricsLoadingRow } from "@repo/app/shared/components/summary-metrics-loading-row";
import {
  isSummaryCardVisible,
  SESSIONS_SUMMARY_CARD_IDS,
  SessionsSummaryCardId,
} from "./sessions-summary-card-visibility";
import { SUMMARY_COMPARISON_SHELL_SHIMMER } from "./sessions-summary-delta-slots";
import { useSessionsSummaryCardLabels } from "./use-sessions-summary-card-labels";

/**
 * The Sessions summary strip while the parent's usage read is still pending.
 *
 * ISS-5070 item 3, closed by ISS-5366 (stage review). This used to render five
 * bare `Skeleton` slabs at a hardcoded `h-[124px]`. That literal predated the
 * dense strip and was never re-measured against a live compact card, so at every
 * width the tier resolves compact — which includes the desktop launch width, and
 * therefore every first load — the slab was TALLER than the card that replaced
 * it and the strip (and the whole table under it) jumped once the data landed.
 *
 * It was deferred on the grounds that both candidate fixes would change the
 * flag-OFF loading state and so needed their own gate. That reason retired with
 * the flag, and the fix taken here is the one that cannot drift again rather than
 * the one that re-measures a literal: the skeleton IS the card. Each slot is a
 * real `MetricCard` in its `loading` state, so it inherits the card's own
 * padding, caption reservation and label line box at whatever density the row
 * resolves. There is no height to keep in sync, at any density, ever.
 *
 * Everything the shell shows is honest about being unsettled: the value slot is
 * skeletoned by `MetricCard loading`, the caption says the row is loading, and
 * the delta slot (below) reserves with a skeleton rather than a claim. The one
 * thing the shell states as fact is the LABEL, which is known before the read
 * and is the reason the reader can already tell which five metrics are coming.
 *
 * ISS-9887: that strip is now `SummaryMetricsLoadingRow`, shared with the
 * Branches summary row, which had reached the same shape independently and then
 * diverged from it on reload. What is left here is Sessions' own vocabulary —
 * which cards are visible, and what the fifth one is called.
 */
export function SessionsSummaryCardsLoading({
  className,
  cardClassName,
  loadingDetail,
  locPerDollarLabel,
  reservesDeltaSlot,
  wrapBelow = false,
  hiddenCardIds,
}: {
  className?: string;
  /** Per-card sizing, resolved by the caller from its layout mode. */
  cardClassName: string;
  /** The caption every shell carries, shared with the settled cards' own wait state. */
  loadingDetail: string;
  /**
   * The LOC/$ card's label, resolved by the caller.
   *
   * ISS-9978: this is no longer flag-picked, and the two renders CAN now
   * disagree. The settled card resolves its label from the response's
   * `mergedLocPerDollarBasis`, which does not exist until the read lands — so
   * the shell necessarily states the shipped label and the settled card
   * repaints a coarser one on the single arm where the server names a basis
   * this build cannot. That is reachable only from a server newer than this
   * client; against every deployed server the two agree. The shell cannot know
   * the basis in advance, so this is a stated limitation rather than a gap to
   * plumb.
   */
  locPerDollarLabel: string;
  /**
   * Whether the host surface COMPARES against a prior period (the web Sessions
   * page does; the desktop view does not). A comparing surface's settled cards
   * carry a delta chip — or the "No prior period" placeholder in the same slot —
   * as an extra row inside `CardContent`, so a shell without that row would be
   * shorter than the card that replaces it and would reintroduce the settle this
   * component exists to remove. Reserved only where it will actually be filled.
   */
  reservesDeltaSlot: boolean;
  wrapBelow?: boolean;
  /**
   * FEA-4217 — the cards switched off in the toolbar's Options menu. The shell
   * has to honour the same set as the settled strip: a shell that reserved five
   * slots for a strip that settles into three would reintroduce exactly the
   * layout jump this component exists to remove.
   */
  hiddenCardIds?: ReadonlySet<string>;
}) {
  // ISS-9971 / ISS-10667: the menu-row vocabulary, which is what three of the
  // five cards settle into. The other two are resolved below.
  const summaryCardLabels = useSessionsSummaryCardLabels();
  return (
    <SummaryMetricsLoadingRow
      cardClassName={cardClassName}
      cards={SESSIONS_SUMMARY_CARD_IDS.filter((id) =>
        isSummaryCardVisible(id, hiddenCardIds)
      ).map((id) => {
        // The LOC/$ label is resolved by the caller, so it is read from the
        // prop rather than the static map. ISS-9978 made the settled card
        // resolve it from the payload's basis, which no loading render can
        // know — see the prop's own doc for why the shell states the shipped
        // label and what that costs on the one unreachable-today arm.
        //
        // Cost is off the map for a different reason: the map spells the metric
        // out for the Options MENU, which cannot take the alias the card
        // renders. A shell on the menu row's word would rewrite the label
        // the instant the read landed — the settle ISS-5366 exists to remove.
        const label = resolveLoadingCardLabel(
          id,
          locPerDollarLabel,
          summaryCardLabels
        );
        return { key: label, label };
      })}
      className={className}
      // A skeleton, NOT the "No prior period" placeholder the settled card
      // uses. The row genuinely does not know yet whether a prior period
      // exists, and printing that line here would be a claim the read has
      // not returned — the same reason the value slot shimmers instead of
      // rendering a zero.
      //
      // ISS-7422 gave the SETTLED strip the same pending state, so the
      // shimmer's geometry is now one shared constant rather than a shape
      // this file owned alone. The shell keeps the BARE variant: it renders
      // ungated, so it must stay byte-identical, and the row's own
      // `aria-busy` already announces the wait that the settled strip has to
      // announce per card.
      deltaPlaceholder={
        reservesDeltaSlot ? SUMMARY_COMPARISON_SHELL_SHIMMER : null
      }
      loadingDetail={loadingDetail}
      wrapBelow={wrapBelow}
    />
  );
}

/** The word each shell states — the two cards whose settled label is not the menu row's. */
function resolveLoadingCardLabel(
  id: SessionsSummaryCardId,
  locPerDollarLabel: string,
  summaryCardLabels: Readonly<Record<SessionsSummaryCardId, string>>
): string {
  if (id === SessionsSummaryCardId.LocPerDollar) {
    return locPerDollarLabel;
  }
  if (id === SessionsSummaryCardId.Cost) {
    return TOTAL_ESTIMATED_COST_ALIAS_LABEL;
  }
  return summaryCardLabels[id];
}
