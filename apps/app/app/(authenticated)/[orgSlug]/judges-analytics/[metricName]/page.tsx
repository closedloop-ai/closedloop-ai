"use client";

import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { useJudgeDetail } from "@repo/app/judges-analytics/hooks/use-judges-analytics";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { Link } from "@repo/navigation/link";
import { useRouteParams } from "@repo/navigation/use-route-params";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { ArrowLeftIcon } from "lucide-react";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { CharacteristicsPanel } from "./components/characteristics-panel";
import { PromptSection } from "./components/prompt-section";
import { ScoreComparisonSection } from "./components/score-comparison-section";

export default function JudgeDetailPage() {
  const params = useRouteParams();
  const searchParams = useSearchParamsValue();
  const orgSlug = useOrgSlug();
  const metricName =
    typeof params.metricName === "string" ? params.metricName : "";
  const promptName = decodeURIComponent(metricName);
  const reportTypeParam = searchParams.get("reportType");
  let reportType: EvaluationReportType = EvaluationReportType.Plan;
  if (reportTypeParam === EvaluationReportType.Code) {
    reportType = EvaluationReportType.Code;
  } else if (reportTypeParam === EvaluationReportType.Prd) {
    reportType = EvaluationReportType.Prd;
  }
  const { data, isLoading, isError, error } = useJudgeDetail(
    promptName,
    reportType
  );

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
        <Link
          className="inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
          href={`/${orgSlug}/judges-analytics`}
        >
          <ArrowLeftIcon className="h-4 w-4" />
          Back to Judges Analytics
        </Link>
        <Alert variant="error">
          <AlertTitle>
            {isError ? "Error loading judge detail" : "Judge not found"}
          </AlertTitle>
          <AlertDescription>
            {error?.message || "The requested judge could not be found."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const { judge } = data;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
      <div>
        <Link
          className="inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
          href={`/${orgSlug}/judges-analytics`}
        >
          <ArrowLeftIcon className="h-4 w-4" />
          Back to Judges Analytics
        </Link>
        <h1 className="mt-2 font-semibold text-2xl tracking-tight">
          {judge.displayName}
        </h1>
        <p className="text-muted-foreground text-sm">
          {judge.scoreCount} total scores across {judge.promptVersions.length}{" "}
          version
          {judge.promptVersions.length === 1 ? "" : "s"}
        </p>
      </div>

      <CharacteristicsPanel judge={judge} />
      <PromptSection judge={judge} />
      <ScoreComparisonSection
        key={`${reportType}-${promptName}`}
        promptName={promptName}
        reportType={reportType}
      />
    </div>
  );
}
