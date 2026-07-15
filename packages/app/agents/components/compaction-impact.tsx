import type { WorkflowCompactionImpactData } from "@repo/app/agents/lib/session-types";
import { Section } from "@repo/design-system/components/ui/layout/section";
import { RankedBar } from "@repo/design-system/components/ui/primitives/ranked-bar";
import { WorkflowStatTile } from "@repo/design-system/components/ui/primitives/workflow-stat-tile";
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
      description="Context-compaction recovery surfaced as reusable stat tiles and ranked bars."
      title="Compaction impact"
    >
      <div className="grid gap-4 md:grid-cols-2">
        <WorkflowStatTile
          description="Observed across decomposed workflow traces"
          label="Total compactions"
          value={formatCompactNumber(data.totalCompactions)}
        />
        <WorkflowStatTile
          description={`${data.sessionsWithCompactions} of ${data.totalSessions} sessions compacted`}
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
