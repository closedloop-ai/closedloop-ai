"use client";

import type { KpiStat } from "@repo/api/src/types/insights";
import { TOTAL_ESTIMATED_COST_COPY } from "@repo/api/src/types/total-estimated-cost-copy";
import { CostMetricCard } from "@repo/app/agents/components/sessions/cost-metric-card";
import { KpiDeltaPlaceholder } from "@repo/app/insights/components/kpi-delta-placeholder";
import { kpiNoComparisonReason } from "@repo/app/insights/lib/kpi-no-comparison-copy";
import { DASHBOARD_METRIC_CARD_CLASS_NAME } from "./dashboard-card";

// FEA-3818: the Cost KPI renders the shared CostMetricCard — the SAME component
// the Sessions summary row uses — so the two surfaces can't drift on formatting,
// the honest-empty `—`, or the delta chip. On THIS surface the card is fed the
// same single-line `kpi.sub` info its four rowmates (and the Insights stat tile)
// render, so the whole Dashboard row shares one voice and one tooltip height.
// The detail line is omitted: this surface's value is the full
// subscription-inclusive aggregate with no separate metered split to caption.
// FEA-3960/3961: the "no comparison" affordance fills the SAME delta slot the
// numeric chip would (via `deltaPlaceholder`), not the separate `trend` corner,
// so the delta info doesn't jump position between cards with and without a
// comparison in a five-card row. Extracted from `OverviewKpiCard` so that
// dispatcher stays under the cognitive-complexity ceiling (ISS-4401).
export function OverviewCostKpiCard({
  kpi,
  hasDelta,
  deltaCapped,
  deltaLabel,
  sparkline,
  hidden,
}: {
  kpi: KpiStat | undefined;
  hasDelta: boolean;
  deltaCapped: boolean;
  deltaLabel: string;
  sparkline: number[] | undefined;
  /** Did the row's `metric-card-hide-unavailable` pass retire this card? */
  hidden: boolean;
}) {
  // ISS-9971 / ISS-9969: the label and tooltip are the one canonical dollar
  // copy, the same words the Sessions card resolves — the producer's
  // `label`/`sub` is not consulted for this tile, so the two screens cannot
  // spell the same figure differently.
  const copy = {
    label: TOTAL_ESTIMATED_COST_COPY.label,
    info: TOTAL_ESTIMATED_COST_COPY.info,
  };
  return (
    <CostMetricCard
      className={DASHBOARD_METRIC_CARD_CLASS_NAME}
      cost={kpi?.value}
      delta={hasDelta ? (kpi?.deltaPct ?? undefined) : undefined}
      deltaCapped={deltaCapped}
      deltaLabel={hasDelta ? deltaLabel : undefined}
      deltaPlaceholder={
        hasDelta ? undefined : (
          <KpiDeltaPlaceholder
            reason={kpiNoComparisonReason(kpi?.deltaBasis)}
          />
        )
      }
      // Unlike its four rowmates this card hands `MetricCard` a real
      // `valueUnavailable`, so the primitive owns the hiding and the row only
      // has to say whether it applies.
      hideWhenUnavailable={hidden}
      // whitlockk review on #4905: fall back to THIS surface's copy, not the
      // component's default. That default is the Sessions copy, and Sessions
      // always passes `info` explicitly, so an `undefined` here was the only
      // production path that reached it — handing the Dashboard a tooltip about
      // "filtered sessions" and a caption beneath the number this surface never
      // renders.
      info={copy.info}
      label={copy.label}
      sparkline={sparkline}
    />
  );
}
