import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import type { DocumentTypeGroup } from "@repo/api/src/types/judges-analytics";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { SearchX } from "lucide-react";
import { DocumentTypeSection } from "./document-type-section";

type ReportTypeSectionProps = {
  reportType: EvaluationReportType;
  groups: DocumentTypeGroup[];
};

const REPORT_TYPE_LABEL: Record<EvaluationReportType, string> = {
  [EvaluationReportType.Code]: "Code",
  [EvaluationReportType.Prd]: "PRD",
  [EvaluationReportType.Plan]: "Plan",
  [EvaluationReportType.Feature]: "Issue",
};

const REPORT_TYPE_DESCRIPTION: Record<EvaluationReportType, string> = {
  [EvaluationReportType.Code]:
    "LLM code-judge scores compared against pull request ratings.",
  [EvaluationReportType.Prd]:
    "LLM PRD-judge scores compared against artifact ratings.",
  [EvaluationReportType.Plan]:
    "LLM plan-judge scores compared against artifact ratings.",
  [EvaluationReportType.Feature]:
    "LLM issue-judge scores compared against artifact ratings.",
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
        <EmptyState
          className="min-h-24 py-6"
          icon={SearchX}
          title={`No ${REPORT_TYPE_LABEL[reportType]} evaluations in this range`}
        />
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <DocumentTypeSection
              group={group}
              key={`${reportType}:${group.documentType}`}
              reportType={reportType}
            />
          ))}
        </div>
      )}
    </section>
  );
}
