"use client";

import { SummaryCardRow } from "@repo/app/shared/components/summary-card-row";
import { CardDensity } from "@repo/design-system/components/ui/card-density";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import type { ComponentProps, ReactNode } from "react";

/** One shell in a loading strip: what the row can honestly state before the read lands. */
export type SummaryMetricsLoadingCard = {
  /** React key — the caller's own card id or label. */
  key: string;
  label: string;
  /**
   * The card's info popover, when the surface ships one. Read off the primitive
   * rather than re-declared, so a shell cannot silently narrow the shape the
   * settled card renders (design review on #6957).
   */
  info?: ComponentProps<typeof MetricCard>["info"];
};

/**
 * The loading strip both list summary rows render (ISS-9887).
 *
 * The skeleton IS the card: each slot is a real `MetricCard` in its `loading`
 * state inside the shared `SummaryCardRow`, so it inherits the card's own
 * padding, caption reservation and label line box at the density the row
 * carries (pinned `Compact` since ISS-10540, below), and there is no reserved
 * height to keep in sync. That contract came
 * from the Sessions strip (ISS-5366); Branches reached the same shape
 * independently for its never-loaded state (ISS-8510) and then diverged from it
 * on reload. One component now renders both, so the next state either row adds
 * cannot be added to only one of them.
 *
 * Everything here is honest about being unsettled — the value slot shimmers, the
 * caption says the row is loading, and the delta slot reserves with a skeleton
 * rather than a claim. The one thing a shell states as fact is the LABEL, which
 * is known before the read and is why the reader can already tell which metrics
 * are coming.
 */
export function SummaryMetricsLoadingRow({
  cards,
  cardClassName,
  className,
  deltaPlaceholder,
  loadingDetail,
  wrapBelow = false,
}: {
  cards: readonly SummaryMetricsLoadingCard[];
  /** Per-card sizing, resolved by the caller from its layout mode. */
  cardClassName: string;
  className?: string;
  /**
   * What reserves the comparison slot, when the host surface compares periods at
   * all. A shimmer, never the settled "No comparison" placeholder: the row does
   * not yet know whether a prior period exists, and printing that line here
   * would be a claim the read has not returned.
   */
  deltaPlaceholder?: ReactNode;
  /** The caption every shell carries, shared with the settled cards' wait state. */
  loadingDetail: string;
  wrapBelow?: boolean;
}) {
  return (
    <SummaryCardRow
      busy
      className={className}
      density={CardDensity.Compact}
      wrapBelow={wrapBelow}
    >
      {cards.map((card) => (
        <MetricCard
          className={cardClassName}
          deltaPlaceholder={deltaPlaceholder}
          detail={loadingDetail}
          info={card.info}
          key={card.key}
          label={card.label}
          loading
          value={null}
        />
      ))}
    </SummaryCardRow>
  );
}
