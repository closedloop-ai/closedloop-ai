import type { EvaluationReportType } from "@repo/api/src/types/evaluation";
import type { DocumentTypeGroup } from "@repo/api/src/types/judges-analytics";
import { JudgeAnalyticsChart } from "./judge-analytics-chart";
import { JudgeAnalyticsTable } from "./judge-analytics-table";

type DocumentTypeSectionProps = {
  group: DocumentTypeGroup;
  reportType: EvaluationReportType;
};

export function DocumentTypeSection({
  group,
  reportType,
}: DocumentTypeSectionProps) {
  return (
    <section>
      <h2 className="mb-4 font-semibold text-xl">{group.documentType}</h2>
      <div className="flex flex-col gap-4">
        <JudgeAnalyticsChart
          data={group.judges}
          documentType={group.documentType}
        />
        <JudgeAnalyticsTable data={group.judges} reportType={reportType} />
      </div>
    </section>
  );
}
