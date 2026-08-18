"use client";

import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { summaryKpis } from "../mock";

const WRAP_CLASS = "grid grid-cols-1 gap-3 lg:grid-cols-3 xl:grid-cols-5";
const CARD_CLASS = "min-w-[11rem] flex-1 basis-[11rem] sm:basis-[12rem]";
const DELTA_LABEL = "vs. prior 30 days";

export function BranchesSummaryCards({ showDelta }: { showDelta: boolean }) {
  return (
    <div className={WRAP_CLASS}>
      {summaryKpis.map((kpi) => {
        // `delta`/`deltaPolarity` are a paired union on MetricCard (#4148): pass
        // the polarity only alongside a real number.
        const delta = showDelta ? kpi.delta : undefined;
        if (delta == null) {
          return (
            <MetricCard
              className={CARD_CLASS}
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
            delta={delta}
            deltaLabel={DELTA_LABEL}
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
