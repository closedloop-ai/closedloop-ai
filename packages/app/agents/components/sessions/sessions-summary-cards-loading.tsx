"use client";

import { SummaryCardRow } from "@repo/app/shared/components/summary-card-row";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { SESSIONS_COST_METRIC_CARD_LABEL } from "./cost-metric-card";
import {
  PRS_SHIPPED_METRIC_CARD_LABEL,
  SESSIONS_METRIC_CARD_LABEL,
  TOTAL_TOKENS_METRIC_CARD_LABEL,
} from "./sessions-summary-card-labels";

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
 */
export function SessionsSummaryCardsLoading({
  className,
  cardClassName,
  loadingDetail,
  locPerDollarLabel,
  reservesDeltaSlot,
  wrapBelow = false,
}: {
  className?: string;
  /** Per-card sizing, resolved by the caller from its layout mode. */
  cardClassName: string;
  /** The caption every shell carries, shared with the settled cards' own wait state. */
  loadingDetail: string;
  /**
   * The LOC/$ card's label, resolved by the caller. It is picked from a feature
   * flag, and the flag is read once in the settled component rather than a
   * second time here, so the two renders cannot disagree about which label the
   * fifth card carries.
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
}) {
  return (
    <SummaryCardRow busy className={className} wrapBelow={wrapBelow}>
      {[
        SESSIONS_METRIC_CARD_LABEL,
        TOTAL_TOKENS_METRIC_CARD_LABEL,
        SESSIONS_COST_METRIC_CARD_LABEL,
        PRS_SHIPPED_METRIC_CARD_LABEL,
        locPerDollarLabel,
      ].map((label) => (
        <MetricCard
          className={cardClassName}
          // A skeleton, NOT the "No prior period" placeholder the settled card
          // uses. The row genuinely does not know yet whether a prior period
          // exists, and printing that line here would be a claim the read has
          // not returned — the same reason the value slot shimmers instead of
          // rendering a zero.
          deltaPlaceholder={
            reservesDeltaSlot ? <Skeleton className="h-4 w-24 rounded" /> : null
          }
          detail={loadingDetail}
          key={label}
          label={label}
          loading
          value={null}
        />
      ))}
    </SummaryCardRow>
  );
}
