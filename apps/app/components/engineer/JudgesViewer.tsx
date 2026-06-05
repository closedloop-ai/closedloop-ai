"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import {
  type CaseScore,
  EvalStatus,
  type EvaluationReport,
  symphonyJudgesOptions,
} from "@/lib/engineer/queries/symphony";
import { formatScorePercent } from "@/lib/evaluation-utils";

type JudgesViewerProps = {
  /** Ticket ID for fetching judges data */
  ticketId: string;
  /** Worktree repo path */
  repoPath: string;
  /** Controls dialog visibility */
  isOpen: boolean;
  /** Called when dialog should close */
  onClose: () => void;
};

/**
 * JudgesViewer displays LLM Judge evaluation scores from judges.json.
 * Shows a progress bar with acceptance rate and a scrollable list of case scores
 * with expandable details for metrics and justifications.
 */
export function JudgesViewer({
  ticketId,
  repoPath,
  isOpen,
  onClose,
}: Readonly<JudgesViewerProps>) {
  const { data, isLoading, isError, error, refetch } = useQuery(
    symphonyJudgesOptions(ticketId, repoPath)
  );

  const [expandedScoreId, setExpandedScoreId] = useState<string | null>(null);

  // Calculate acceptance rate from case_score entries
  const acceptanceRate = calculateAcceptanceRate(data?.data);

  // Sort case scores by first metric score in ascending order
  const sortedCaseScores = getSortedCaseScores(data?.data);

  return (
    <Dialog onOpenChange={onClose} open={isOpen}>
      <DialogContent className="flex h-[90vh] max-h-[90vh] w-[95vw] max-w-[95vw] flex-col p-0 lg:max-w-[85vw] xl:max-w-[80vw]">
        <DialogTitle className="sr-only">LLM Judge Scores</DialogTitle>
        <div className="flex shrink-0 items-center justify-between border-b p-4">
          <div className="flex flex-col gap-0.5">
            <h2 className="font-semibold text-lg">LLM Judge Scores</h2>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-6">
          <JudgesContent
            acceptanceRate={acceptanceRate}
            data={data}
            error={error}
            expandedScoreId={expandedScoreId}
            isError={isError}
            isLoading={isLoading}
            onToggleScore={setExpandedScoreId}
            refetch={refetch}
            sortedCaseScores={sortedCaseScores}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function renderErrorState(
  data: unknown,
  error: Error | null,
  refetch: () => void
): React.ReactElement {
  const response = data as
    | { error?: string; message?: string; exists?: boolean }
    | undefined;

  if (response?.error?.startsWith("Judges feedback is corrupted")) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <XCircle className="h-12 w-12 text-destructive" />
        <p className="font-medium text-foreground text-sm">
          Judges feedback is corrupted
        </p>
        <p className="max-w-md text-center text-muted-foreground text-xs">
          {response.error}
        </p>
        <Button onClick={() => refetch()} size="sm" variant="outline">
          <RefreshCw className="h-4 w-4" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <XCircle className="h-12 w-12 text-destructive" />
      <p className="font-medium text-foreground text-sm">
        {response?.error || error?.message || "Failed to load judge scores"}
      </p>
      <Button onClick={() => refetch()} size="sm" variant="outline">
        <RefreshCw className="h-4 w-4" />
        Retry
      </Button>
    </div>
  );
}

type AcceptanceRate = {
  passedCount: number;
  totalCount: number;
  percentage: number;
};

function calculateAcceptanceRate(
  report: EvaluationReport | null | undefined
): AcceptanceRate | null {
  if (!report?.stats) {
    return null;
  }

  const totalCount = report.stats.length;

  if (totalCount === 0) {
    return null;
  }

  // Count cases where inferred status is Passed
  const passedCount = report.stats.filter(
    (score) => inferStatusFromScore(score) === EvalStatus.Passed
  ).length;

  const percentage = (passedCount / totalCount) * 100;

  return { passedCount, totalCount, percentage };
}

function getProgressBarColor(percentage: number): string {
  if (percentage >= 80) {
    return "bg-green-500";
  }
  if (percentage >= 50) {
    return "bg-amber-500";
  }
  return "bg-red-500";
}

function getScore(score: CaseScore): number | null {
  return score.metrics[0]?.score ?? null;
}

function inferStatusFromScore(caseScore: CaseScore): EvalStatus {
  // Check if all metrics pass their thresholds
  const allPassed = caseScore.metrics.every(
    (m) => m.score !== null && m.score >= m.threshold
  );
  if (allPassed) {
    return EvalStatus.Passed;
  }

  // Check if any metric is close to threshold (within 80%)
  const anyClose = caseScore.metrics.some(
    (m) => m.score !== null && m.score >= m.threshold * 0.8
  );
  if (anyClose) {
    return EvalStatus.NeedsImprovement;
  }

  return EvalStatus.Failed;
}

function getSortedCaseScores(
  report: EvaluationReport | null | undefined
): CaseScore[] {
  if (!report?.stats) {
    return [];
  }

  // Filter to only case_score entries
  const validScores = report.stats.filter(
    (score): score is CaseScore => score.type === "case_score"
  );

  // Sort by first metric score in ascending order (lowest first)
  return validScores.sort((a, b) => {
    const scoreA = getScore(a) ?? 0;
    const scoreB = getScore(b) ?? 0;
    return scoreA - scoreB;
  });
}

function renderStatusIcon(status: EvalStatus): React.ReactElement {
  if (status === EvalStatus.Failed) {
    return <XCircle className="h-5 w-5 text-red-500" />;
  }
  if (status === EvalStatus.NeedsImprovement) {
    return <AlertCircle className="h-5 w-5 text-amber-500" />;
  }
  return <CheckCircle className="h-5 w-5 text-green-500" />;
}

function getStatusLabel(status: EvalStatus): string {
  if (status === EvalStatus.Failed) {
    return "Failed";
  }
  if (status === EvalStatus.NeedsImprovement) {
    return "Needs Improvement";
  }
  return "Passed";
}

function formatJudgeName(caseId: string): string {
  // Convert case_id to readable judge name
  // Example: "case_001" -> "Judge 001"
  const match = new RegExp(/case[_-]?(\d+)/i).exec(caseId);
  if (match === null) {
    return caseId;
  }
  return `Judge ${match[1]}`;
}

function JudgesContent({
  isLoading,
  isError,
  data,
  error,
  refetch,
  acceptanceRate,
  sortedCaseScores,
  expandedScoreId,
  onToggleScore,
}: Readonly<{
  isLoading: boolean;
  isError: boolean;
  data:
    | {
        exists?: boolean;
        error?: string;
        message?: string;
        data?: EvaluationReport | null;
      }
    | undefined;
  error: Error | null;
  refetch: () => void;
  acceptanceRate: AcceptanceRate | null;
  sortedCaseScores: CaseScore[];
  expandedScoreId: string | null;
  onToggleScore: (id: string | null) => void;
}>): React.ReactElement | null {
  if (isLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-muted-foreground text-sm">Loading scores...</p>
      </div>
    );
  }

  if (isError || data?.error) {
    return renderErrorState(data, error, refetch);
  }

  if (!data?.exists) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <AlertCircle className="h-12 w-12 text-muted-foreground" />
        <p className="text-muted-foreground text-sm">
          {data?.message || "Awaiting LLM judges feedback"}
        </p>
      </div>
    );
  }

  if (!acceptanceRate) {
    return null;
  }

  return (
    <div className="space-y-4">
      {/* Progress bar showing acceptance rate */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">
            {acceptanceRate.passedCount}/{acceptanceRate.totalCount} judges
            passed
          </span>
          <span className="text-muted-foreground">
            {acceptanceRate.percentage.toFixed(1)}%
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full transition-all ${getProgressBarColor(acceptanceRate.percentage)}`}
            style={{ width: `${acceptanceRate.percentage}%` }}
          />
        </div>
      </div>
      {/* Scrollable list of case scores */}
      <div className="flex-1 space-y-2 overflow-auto">
        {sortedCaseScores.map((score) => (
          <CaseScoreRow
            expandedScoreId={expandedScoreId}
            key={score.case_id}
            onToggleScore={onToggleScore}
            score={score}
          />
        ))}
      </div>
    </div>
  );
}

function CaseScoreRow({
  score,
  expandedScoreId,
  onToggleScore,
}: Readonly<{
  score: CaseScore;
  expandedScoreId: string | null;
  onToggleScore: (id: string | null) => void;
}>) {
  const isExpanded = expandedScoreId === score.case_id;

  return (
    <div>
      <button
        className="flex w-full items-center justify-between rounded-md border p-3 text-left transition-colors hover:bg-muted/50"
        onClick={() => onToggleScore(isExpanded ? null : score.case_id)}
      >
        <div className="flex items-center gap-3">
          {renderStatusIcon(inferStatusFromScore(score))}
          <span className="font-medium text-sm">
            {formatJudgeName(score.case_id)}
          </span>
        </div>
        <span className="text-muted-foreground text-xs">
          {getScore(score) !== null
            ? formatScorePercent(getScore(score)!)
            : "N/A"}
        </span>
      </button>
      {isExpanded && (
        <div className="mt-2 space-y-3 rounded-b-md border border-t-0 bg-muted/20 p-4">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-muted-foreground">Case ID:</span>{" "}
              <span className="font-mono text-xs">{score.case_id}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Status:</span>{" "}
              <span className="font-medium">
                {getStatusLabel(inferStatusFromScore(score))}
              </span>
            </div>
          </div>
          {score.metrics.length > 0 && (
            <div className="space-y-2">
              <h4 className="font-medium text-sm">Metrics</h4>
              {score.metrics.map((metric) => (
                <div
                  className="space-y-1 rounded border bg-background p-3"
                  key={metric.metric_name}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm">
                      {metric.metric_name}
                    </span>
                    <span className="text-sm">
                      Score:{" "}
                      {metric.score != null
                        ? formatScorePercent(metric.score)
                        : "N/A"}
                    </span>
                  </div>
                  {metric.threshold !== null && (
                    <div className="text-muted-foreground text-xs">
                      Threshold: {formatScorePercent(metric.threshold)}
                    </div>
                  )}
                  {metric.justification ? (
                    <div className="mt-2 text-muted-foreground text-xs">
                      {metric.justification}
                    </div>
                  ) : (
                    <div className="mt-2 text-muted-foreground text-xs italic">
                      No justification available
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
