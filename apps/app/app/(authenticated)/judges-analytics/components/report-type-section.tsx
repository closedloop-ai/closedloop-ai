import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import type { ArtifactTypeGroup } from "@repo/api/src/types/judges-analytics";
import { ArtifactTypeSection } from "./artifact-type-section";

type ReportTypeSectionProps = {
  reportType: EvaluationReportType;
  groups: ArtifactTypeGroup[];
};

export function ReportTypeSection({
  reportType,
  groups,
}: ReportTypeSectionProps) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-semibold text-xl">
          {reportType === EvaluationReportType.Code ? "Code" : "Plan"}
        </h2>
        <p className="text-muted-foreground text-sm">
          {reportType === EvaluationReportType.Code
            ? "LLM code-judge scores compared against pull request ratings."
            : "LLM plan-judge scores compared against artifact ratings."}
        </p>
      </div>
      {groups.length === 0 ? (
        <div className="rounded-lg border border-border bg-muted/50 p-6 text-center">
          <p className="text-muted-foreground">
            No judge evaluations found for this report type in the selected date
            range.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <ArtifactTypeSection
              group={group}
              key={`${reportType}:${group.artifactType}`}
              reportType={reportType}
            />
          ))}
        </div>
      )}
    </section>
  );
}
