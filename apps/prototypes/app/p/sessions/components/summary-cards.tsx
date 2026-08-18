"use client";

import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import type { SummaryKpi } from "../mock-kpis";

const WRAP_CLASS = "grid grid-cols-1 gap-3 lg:grid-cols-3 xl:grid-cols-5";
const CARD_CLASS = "min-w-[11rem] flex-1 basis-[11rem] sm:basis-[12rem]";

// Filled into the delta slot when the active range has no prior period ("All
// time"), so the footer keeps a stable layout instead of dropping the chip.
const NO_COMPARISON = (
  <span className="text-muted-foreground text-xs">No prior period</span>
);

export function SessionsSummaryCards({ kpis }: { kpis: SummaryKpi[] }) {
  return (
    <div className={WRAP_CLASS}>
      {kpis.map((kpi) => {
        // `delta`/`deltaPolarity` are a paired union on MetricCard (#4148): pass
        // the polarity only alongside a real number; otherwise fill the slot with
        // the "No prior period" placeholder.
        if (kpi.delta == null) {
          return (
            <MetricCard
              className={CARD_CLASS}
              deltaPlaceholder={NO_COMPARISON}
              detail={kpi.detail}
              info={kpi.info}
              key={kpi.key}
              label={kpi.label}
              value={kpi.value}
            />
          );
        }
        return (
          <MetricCard
            className={CARD_CLASS}
            delta={kpi.delta}
            deltaLabel={kpi.deltaLabel}
            deltaPolarity={MetricPolarity.HigherIsBetter}
            detail={kpi.detail}
            info={kpi.info}
            key={kpi.key}
            label={kpi.label}
            value={kpi.value}
          />
        );
      })}
    </div>
  );
}
