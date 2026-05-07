"use client";

import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useJudgeDetail } from "@/hooks/queries/use-judges-analytics";
import { CharacteristicsPanel } from "./components/characteristics-panel";
import { PromptSection } from "./components/prompt-section";
import { ScoreComparisonSection } from "./components/score-comparison-section";

export default function JudgeDetailPage() {
  const params = useParams<{ metricName: string }>();
  const searchParams = useSearchParams();
  const promptName = decodeURIComponent(params.metricName);
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
          href="/judges-analytics"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          Back to Judges Analytics
        </Link>
        <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
          <p className="font-medium text-destructive">
            {isError ? "Error loading judge detail" : "Judge not found"}
          </p>
          <p className="text-muted-foreground text-sm">
            {error?.message || "The requested judge could not be found."}
          </p>
        </div>
      </div>
    );
  }

  const { judge } = data;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
      <div>
        <Link
          className="inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
          href="/judges-analytics"
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
