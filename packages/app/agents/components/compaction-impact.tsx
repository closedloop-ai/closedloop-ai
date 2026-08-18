import type { WorkflowCompactionImpactData } from "@repo/app/agents/lib/session-types";
import { Section } from "@repo/design-system/components/ui/layout/section";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { RankedBar } from "@repo/design-system/components/ui/primitives/ranked-bar";
import { formatCompactNumber } from "@repo/design-system/components/ui/utils";

export function CompactionImpact({
  data,
}: {
  data: WorkflowCompactionImpactData;
}) {
  const maxCompactions = Math.max(
    ...data.perSession.map((item) => item.compactions),
    1
  );

  return (
    <Section
      contentClassName="space-y-4"
      description="How much context compaction recovered across decomposed workflow traces, and how it breaks down per session."
      title="Compaction impact"
    >
      <div className="grid gap-4 md:grid-cols-2">
        <MetricCard
          detail={`${data.sessionsWithCompactions} of ${data.totalSessions} sessions compacted`}
          info={{
            what: "Total context compactions observed across decomposed workflow traces.",
          }}
          label="Total compactions"
          value={data.totalCompactions}
        />
        <MetricCard
          info={{
            what: "Context tokens recovered by compacting sessions across decomposed workflow traces.",
          }}
          label="Recovered tokens"
          value={formatCompactNumber(data.tokensRecovered)}
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
