"use client";

import type { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { computeMean } from "@repo/api/src/utils/math";
import { Button } from "@repo/design-system/components/ui/button";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { useJudgeScores } from "@/hooks/queries/use-judge-scores";
import { ScoreComparisonTable } from "./score-comparison-table";

type ScoreComparisonSectionProps = {
  promptName: string;
  reportType: EvaluationReportType;
};

export function ScoreComparisonSection({
  promptName,
  reportType,
}: ScoreComparisonSectionProps) {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError } = useJudgeScores(
    promptName,
    reportType,
    page
  );

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <p className="text-muted-foreground text-sm">
        Unable to load score comparison data.
      </p>
    );
  }

  const { pagination } = data;
  const visibleRows = data.rows.slice(0, MAX_VISUALIZED_ARTIFACTS);
  const avgJudgeScore = computeMean(visibleRows.map((row) => row.judgeScore));
  const avgHumanScore = computeMean(
    visibleRows.map((row) => row.avgUserRating)
  );

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-lg">Score Comparison</h2>
      <p className="text-muted-foreground text-sm">
        {data.totalArtifacts} artifacts evaluated &mdash; {data.ratedArtifacts}{" "}
        rated by at least one org member ({data.coveragePct.toFixed(0)}%
        coverage).
      </p>
      <p className="text-sm" data-testid="score-comparison-aggregates">
        Averages (visible): Judge {avgJudgeScore.toFixed(2)} &middot; Human{" "}
        {avgHumanScore.toFixed(2)}
      </p>
      <ScoreComparisonTable rows={visibleRows} />
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-sm">
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <div className="flex gap-2">
            <Button
              disabled={pagination.page <= 1}
              onClick={() => setPage((p) => p - 1)}
              size="sm"
              variant="outline"
            >
              <ChevronLeftIcon className="mr-1 h-4 w-4" />
              Previous
            </Button>
            <Button
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => setPage((p) => p + 1)}
              size="sm"
              variant="outline"
            >
              Next
              <ChevronRightIcon className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const MAX_VISUALIZED_ARTIFACTS = 20;
