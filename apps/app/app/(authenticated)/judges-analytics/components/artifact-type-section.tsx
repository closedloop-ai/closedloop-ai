import type { ArtifactSubtypeGroup } from "@repo/api/src/types/judges-analytics";
import { JudgeAnalyticsChart } from "./judge-analytics-chart";
import { JudgeAnalyticsTable } from "./judge-analytics-table";

type ArtifactTypeSectionProps = {
  group: ArtifactSubtypeGroup;
};

export function ArtifactTypeSection({ group }: ArtifactTypeSectionProps) {
  return (
    <section>
      <h2 className="mb-4 font-semibold text-xl">{group.artifactSubtype}</h2>
      <div className="flex flex-col gap-4">
        <JudgeAnalyticsChart
          artifactSubtype={group.artifactSubtype}
          data={group.judges}
        />
        <JudgeAnalyticsTable data={group.judges} />
      </div>
    </section>
  );
}
