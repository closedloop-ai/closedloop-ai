import type {
  ArtifactTypeGroup,
  JudgesAnalyticsReportType,
} from "@repo/api/src/types/judges-analytics";
import { JudgeAnalyticsChart } from "./judge-analytics-chart";
import { JudgeAnalyticsTable } from "./judge-analytics-table";

type ArtifactTypeSectionProps = {
  group: ArtifactTypeGroup;
  reportType: JudgesAnalyticsReportType;
};

export function ArtifactTypeSection({
  group,
  reportType,
}: ArtifactTypeSectionProps) {
  return (
    <section>
      <h2 className="mb-4 font-semibold text-xl">{group.artifactType}</h2>
      <div className="flex flex-col gap-4">
        <JudgeAnalyticsChart
          artifactType={group.artifactType}
          data={group.judges}
        />
        <JudgeAnalyticsTable data={group.judges} reportType={reportType} />
      </div>
    </section>
  );
}
