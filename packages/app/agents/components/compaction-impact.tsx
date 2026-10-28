"use client";

import type { WorkflowCompactionImpactData } from "@repo/app/agents/lib/session-types";
import { useMetricCardHideUnavailable } from "@repo/app/shared/feature-flags/use-metric-card-hide-unavailable";
import { hiddenMetricCardIds } from "@repo/app/shared/lib/metric-card-hide-policy";
import { Section } from "@repo/design-system/components/ui/layout/section";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { RankedBar } from "@repo/design-system/components/ui/primitives/ranked-bar";
import { formatCompactNumber } from "@repo/design-system/components/ui/utils";

/**
 * Both cards below take a required non-nullable count off `data`, so neither can
 * reach `MetricCard`'s no-data slot — the gate is wired for consistency but has
 * nothing to hide here unless that shape becomes optional.
 */
export function CompactionImpact({
  data,
}: {
  data: WorkflowCompactionImpactData;
}) {
  const hideUnavailable = useMetricCardHideUnavailable();
  const maxCompactions = Math.max(
    ...data.perSession.map((item) => item.compactions),
    1
  );
  const hidden = hiddenMetricCardIds({
    cards: [
      {
        id: CompactionCardId.TotalCompactions,
        notComputable: data.totalCompactions == null,
      },
      {
        id: CompactionCardId.TokensRecovered,
        notComputable: data.tokensRecovered == null,
      },
    ],
    enabled: hideUnavailable,
  });

  return (
    <Section
      contentClassName="space-y-4"
      description="How much context compaction recovered across decomposed workflow traces, and how it breaks down per session."
      title="Compaction impact"
    >
      <div className="grid gap-4 md:grid-cols-2">
        <MetricCard
          detail={`${data.sessionsWithCompactions} of ${data.totalSessions} sessions compacted`}
          hideWhenUnavailable={hidden.has(CompactionCardId.TotalCompactions)}
          info={{
            what: "Total context compactions observed across decomposed workflow traces.",
          }}
          label="Total compactions"
          value={data.totalCompactions}
        />
        <MetricCard
          hideWhenUnavailable={hidden.has(CompactionCardId.TokensRecovered)}
          info={{
            what: "Context tokens recovered by compacting sessions across decomposed workflow traces.",
          }}
          label="Recovered tokens"
          value={
            data.tokensRecovered == null
              ? null
              : formatCompactNumber(data.tokensRecovered)
          }
        />
      </div>

      <div className="space-y-3">
        {data.perSession.map((item) => (
          <RankedBar
            key={item.sessionId}
            label={item.sessionId}
            percent={(item.compactions / maxCompactions) * 100}
            value={item.compactions}
          />
        ))}
      </div>
    </Section>
  );
}

const CompactionCardId = {
  TotalCompactions: "totalCompactions",
  TokensRecovered: "tokensRecovered",
} as const;
