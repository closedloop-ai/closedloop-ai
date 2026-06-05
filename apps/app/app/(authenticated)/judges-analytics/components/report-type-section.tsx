import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import type { ArtifactTypeGroup } from "@repo/api/src/types/judges-analytics";
import { ArtifactTypeSection } from "./artifact-type-section";

type ReportTypeSectionProps = {
  reportType: EvaluationReportType;
  groups: ArtifactTypeGroup[];
};

const REPORT_TYPE_LABEL: Record<EvaluationReportType, string> = {
  [EvaluationReportType.Code]: "Code",
  [EvaluationReportType.Prd]: "PRD",
  [EvaluationReportType.Plan]: "Plan",
};

const REPORT_TYPE_DESCRIPTION: Record<EvaluationReportType, string> = {
  [EvaluationReportType.Code]:
    "LLM code-judge scores compared against pull request ratings.",
  [EvaluationReportType.Prd]:
    "LLM PRD-judge scores compared against artifact ratings.",
  [EvaluationReportType.Plan]:
    "LLM plan-judge scores compared against artifact ratings.",
};

export function ReportTypeSection({
  reportType,
  groups,
}: ReportTypeSectionProps) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-semibold text-xl">
          {REPORT_TYPE_LABEL[reportType]}
        </h2>
        <p className="text-muted-foreground text-sm">
          {REPORT_TYPE_DESCRIPTION[reportType]}
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
