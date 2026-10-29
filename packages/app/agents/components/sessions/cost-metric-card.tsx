"use client";

import {
  TOTAL_ESTIMATED_COST_ALIAS_LABEL,
  TOTAL_ESTIMATED_COST_COPY,
  TOTAL_ESTIMATED_COST_LABEL,
} from "@repo/api/src/types/total-estimated-cost-copy";
// Sibling-slice import (agents → insights): the canonical KPI polarity registry,
// so the Cost card reads its lower-is-better verdict from the SAME declaration
// the Dashboard/Insights tiles route through instead of hardcoding a second copy
// that could silently drift from the catalog (ISS-4633, review on #4148).
import {
  InsightsKpiKey,
  KPI_METRIC_POLARITY,
} from "@repo/app/insights/lib/kpi-polarity";
import { useMetricDeltaTreatment } from "@repo/app/shared/feature-flags/use-metric-delta-treatment";
import { formatCurrencyTileValue } from "@repo/app/shared/lib/format-utils";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import type { MetricDeltaTreatment } from "@repo/design-system/components/ui/primitives/metric-polarity";
import type { ReactNode } from "react";

/**
 * The default label, for a caller that renders a cost card outside the
 * Sessions/Dashboard product surfaces (stories, harnesses).
 *
 * BOUND to {@link TOTAL_ESTIMATED_COST_ALIAS_LABEL} rather than re-typed: until
 * the operator ruling of 2026-09-20 this word appeared nowhere else, and the
 * Sessions card taking the alias made an unbound literal here a second
 * declaration of one string. The Dashboard KPI still passes the canonical
 * phrase, which is why this is a default and not the card's one answer.
 */
export const COST_METRIC_CARD_LABEL = TOTAL_ESTIMATED_COST_ALIAS_LABEL;

export type CostMetricCardProps = {
  /**
   * The dollar amount rendered as the card headline. A finite number (including
   * `0` — an honest zero for a set that cost nothing) formats as whole dollars;
   * `null`/`undefined`/non-finite renders the honest-empty `—` sentinel (the
   * metric is unavailable for the window, never a misleading `$0`), matching the
   * KPI-tile currency formatter.
   */
  cost: number | null | undefined;
  /** Card label / accessible name. */
  label?: string;
  /**
   * Info popover copy (what/how). Defaults to the one canonical explanation of
   * the one dollar figure, which since ISS-10597 is what every shipped surface
   * headlines; breakdown mode passes its own lane copy instead.
   */
  info?: { what: string; how?: string };
  /** Detail line beneath the value (e.g. the subscription-inclusive total). */
  detail?: ReactNode;
  /**
   * ISS-4748 — breakdown lanes beneath the footer, passed straight through to
   * `MetricCard`'s slot. Absent on every caller that is not in breakdown mode,
   * and an absent slot renders nothing, so the card is unchanged for them.
   */
  lanes?: ReactNode;
  /**
   * Period-over-period change chip. A number renders the signed delta; omit for
   * surfaces (e.g. the Sessions summary row) that have no comparison endpoint.
   */
  delta?: number;
  /**
   * Marks the delta as clamped to the display ceiling (FEA-3959) so the chip
   * renders "+999%+" instead of an unbounded figure. Forwarded to the underlying
   * MetricCard; ignored when `delta` is omitted.
   */
  deltaCapped?: boolean;
  /** Caption beside the delta chip (e.g. "vs. prior 90 days"). */
  deltaLabel?: ReactNode;
  /** Recent values powering the delta chip's sparkline. */
  sparkline?: Array<number | null | undefined>;
  /**
   * "No comparison" affordance rendered in the delta slot when there's no
   * numeric `delta` for the range, so the delta info keeps a stable position
   * rather than dropping to a different footer corner. Forwarded to MetricCard's
   * `deltaPlaceholder`; ignored when `delta` is a number.
   */
  deltaPlaceholder?: ReactNode;
  /**
   * ISS-5842 (follow-up, review on #4907): the delta treatment the CALLING
   * surface resolved, when it has one.
   *
   * This card used to read `useMetricDeltaTreatment()` and nothing else, which
   * made it the live counterexample to the Sessions strip's "the slot bag
   * carries the treatment" guarantee: the strip spreads a `deltaSlotProps` bag
   * onto this component, JSX spreads are NOT excess-property checked, and this
   * component destructured explicit props — so the bag's `deltaTreatment` was
   * silently dropped on the floor. It happened to render correctly only because
   * the hook it called resolves the same flag.
   *
   * Declaring the prop makes the bag's value actually flow through, so the
   * strip has ONE source for the treatment rather than two that agree by
   * coincidence. It stays OPTIONAL because the org Dashboard KPI row
   * (`dashboard-rows.tsx`) renders this card without a slot bag; that caller
   * keeps the internally-resolved value, which is the same flag either way.
   */
  deltaTreatment?: MetricDeltaTreatment;
  /** Detail-row trend caption (distinct from the delta slot). */
  trend?: ReactNode;
  className?: string;
  /**
   * FEA-4128: skeleton ONLY the value slot while the cost is still hydrating,
   * keeping the card's label/info/detail chrome. Forwarded to MetricCard.
   */
  loading?: boolean;
  /**
   * Retire the card entirely when it has no cost to state. Resolved by the
   * CALLER, which is the only layer that can tell a settled empty from a failed
   * read — this component receives both as the same nullish `cost`.
   */
  hideWhenUnavailable?: boolean;
};

/**
 * Shared "Cost" metric card. Single implementation of the agent-spend cost card
 * rendered on both the Sessions summary row and the org Dashboard KPI row, so
 * the two surfaces can't drift on formatting, label, the honest-empty `—`, or
 * the delta chip (FEA-3818). Each surface passes its own value + truthful info
 * copy (the two backends compute cost on different bases), but the presentation
 * is now one component.
 */
export function CostMetricCard({
  cost,
  label = COST_METRIC_CARD_LABEL,
  info = TOTAL_ESTIMATED_COST_COPY.info,
  detail,
  lanes,
  delta,
  deltaCapped,
  deltaLabel,
  sparkline,
  deltaPlaceholder,
  deltaTreatment: deltaTreatmentProp,
  trend,
  className,
  loading = false,
  hideWhenUnavailable = false,
}: Readonly<CostMetricCardProps>) {
  // ISS-5842 (ISS-4779 closed-by-default): opt in to the unified delta pill
  // only when this surface's own gate is on — PostHog on web, Labs on desktop.
  // The hook is called unconditionally (it is a hook) and used only as the
  // FALLBACK for a caller that resolved no treatment of its own — the org
  // Dashboard row. A caller that did resolve one (the Sessions strip, via its
  // `deltaSlotProps` bag) wins, so its whole row cannot split across two delta
  // families even if the two ever stopped reading the same flag.
  const surfaceDeltaTreatment = useMetricDeltaTreatment();
  const deltaTreatment = deltaTreatmentProp ?? surfaceDeltaTreatment;
  // Honest-empty: an unavailable metric renders `—` (never a misleading `$0`),
  // and a real `0` still reads as `$0`. Routed through the shared
  // `formatCurrencyTileValue` SSOT so this card and the insights KPI tiles apply
  // the identical null/finite guard + whole-dollar formatting.
  const value = formatCurrencyTileValue(cost);
  // ISS-5401 (design review): tell `MetricCard` the slot is EMPTY, not just what
  // string to paint in it. Handing it a pre-formatted `"—"` leaves `value`
  // non-null, so `noData` stays false and the dash renders at full foreground in
  // `font-semibold` — which `MetricCard`'s own contract calls out as wrong
  // ("never … a bold 2xl em-dash, which reads like a struck/rule value rather
  // than 'nothing to show'", FEA-4236). The GLYPH is unchanged; only the weight
  // and colour move, to the muted treatment the primitive already ships.
  //
  // ISS-9749 ruled this card OUT of `metric-card-hide-unavailable`: both callers
  // (the Sessions strip and the org Dashboard row) hand a FAILED read here as
  // the same `cost == null` a never-computed one arrives as, and neither sets
  // `muted`, so the primitive's guard cannot tell them apart. The separation is
  // owed by the callers that know which happened, not by this component.
  const valueUnavailable = cost == null || !Number.isFinite(cost);

  // With a numeric delta the card MUST declare its polarity (the MetricCard
  // delta/polarity paired union — whitlockk review on #4148); without one it fills
  // the delta slot with the "No comparison" placeholder. Spend is lower-is-better,
  // read from the catalog SSOT so this card can't drift from the Dashboard/Insights
  // Cost tile (ISS-4633).
  if (delta === undefined) {
    return (
      <MetricCard
        className={className}
        deltaPlaceholder={deltaPlaceholder}
        detail={detail}
        hideWhenUnavailable={hideWhenUnavailable}
        info={info}
        label={label}
        lanes={lanes}
        loading={loading}
        trend={trend}
        value={value}
        valueUnavailable={valueUnavailable}
        valueUnavailableLabel={value}
      />
    );
  }

  return (
    <MetricCard
      className={className}
      delta={delta}
      deltaCapped={deltaCapped}
      deltaLabel={deltaLabel}
      deltaPolarity={KPI_METRIC_POLARITY[InsightsKpiKey.Cost]}
      deltaTreatment={deltaTreatment}
      detail={detail}
      hideWhenUnavailable={hideWhenUnavailable}
      info={info}
      label={label}
      lanes={lanes}
      loading={loading}
      sparkline={sparkline}
      trend={trend}
      value={value}
      valueUnavailable={valueUnavailable}
      valueUnavailableLabel={value}
    />
  );
}

/**
 * The heading on the breakdown lanes' disclosure panel, and the accessible name
 * of the dialog Radix builds around it (ISS-4748).
 *
 * The CANONICAL phrase, deliberately, even though the card that opens this panel
 * now renders ruling 7's alias: the alias is authorized only where the phrase
 * measurably does not fit, and a `w-80` popover is not that. The card is short
 * because 207px of card is; this panel has the room to name the metric.
 *
 * It used to be the card's own breakdown-mode label, which is why the name said
 * so. Since the operator ruling of 2026-09-20 no card renders it, so it is named
 * for the one surface that does.
 */
export const SESSIONS_COST_BREAKDOWN_DISCLOSURE_LABEL =
  TOTAL_ESTIMATED_COST_LABEL;

/**
 * ISS-5401 — the caption beneath a Cost headline that dashed because not one of
 * the matched sessions carried a recorded cost.
 *
 * Says the reason, not the state: the `—` already says "unavailable", and the
 * failed-read dash on the same row says exactly that word
 * (`UNAVAILABLE_DETAIL`), so repeating it would leave a reader unable to tell a
 * broken read from an absent-cost cohort.
 *
 * "No cost recorded", NOT the Cost COLUMN's per-row "No pricing data for this
 * model" (`getCostTooltip`), even though the two conditions rhyme. That phrase
 * names a CAUSE — the pricing catalog has no rate for the model — and the
 * aggregate cannot substantiate it. Two audited cohorts reach this caption for a
 * different cause entirely, and the rows beneath them do NOT read alike: the
 * legacy-rollup cohort shows real dollars in the cell, while the
 * subscription-covered cohort shows a fabricated `$0.00` (this caption's
 * predicate is the only one of the two that declines to state a figure). The
 * full split, and why each is accepted, is the KNOWN LIMIT block on
 * {@link isCohortCostUnpriceable} — kept there, not restated here, so the two
 * cannot drift into describing different behaviour. What matters for the
 * WORDING is only that both exist: "no cost recorded" is the weaker claim the
 * tile can always stand behind — no matched session carried a cost figure — and
 * it stays true whatever the cause turns out to be, and whatever the cell beside
 * it prints. "recorded" rather than "data" (design review):
 * "data" is our word for our database and makes the tile read as a system
 * complaint; the reader thinks in money and sessions.
 *
 * Terse because this sits in a ~124px card whose rowmates caption in two to
 * four words — the same constraint every caption on this row is written to.
 */
export const SESSIONS_COST_NO_COST_RECORDED_DETAIL = "No cost recorded";
