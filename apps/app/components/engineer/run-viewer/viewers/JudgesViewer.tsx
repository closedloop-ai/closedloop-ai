"use client";

import { AlertCircle, CheckCircle, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import {
  type CaseScore,
  EvalStatus,
  type EvaluationReport,
} from "@/lib/engineer/queries/symphony";
import { decodeText } from "@/lib/engineer/run-viewer-utils";
import { formatScorePercent } from "@/lib/evaluation-utils";

type JudgesViewerProps = {
  data: Uint8Array;
};

function inferStatusFromScore(caseScore: CaseScore): EvalStatus {
  const allPassed = caseScore.metrics.every(
    (m) => m.score !== null && m.score >= m.threshold
  );
  if (allPassed) {
    return EvalStatus.Passed;
  }

  const anyClose = caseScore.metrics.some(
    (m) => m.score !== null && m.score >= m.threshold * 0.8
  );
  if (anyClose) {
    return EvalStatus.NeedsImprovement;
  }

  return EvalStatus.Failed;
}

function calculateAcceptanceRate(report: EvaluationReport) {
  if (!report.stats || report.stats.length === 0) {
    return null;
  }

  const totalCount = report.stats.length;
  const passedCount = report.stats.filter(
    (s) => inferStatusFromScore(s) === EvalStatus.Passed
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

function formatJudgeName(caseId: string): string {
  const match = /case[_-]?(\d+)/i.exec(caseId);
  if (match === null) {
    return caseId;
  }
  return `Judge ${match[1]}`;
}

function renderStatusIcon(status: EvalStatus) {
  if (status === EvalStatus.Failed) {
    return <XCircle className="size-5 text-red-500" />;
  }
  if (status === EvalStatus.NeedsImprovement) {
    return <AlertCircle className="size-5 text-amber-500" />;
  }
  return <CheckCircle className="size-5 text-green-500" />;
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

export function JudgesViewer({ data }: Readonly<JudgesViewerProps>) {
  const [expandedScoreId, setExpandedScoreId] = useState<string | null>(null);

  const report = useMemo((): EvaluationReport | null => {
    try {
      return JSON.parse(decodeText(data)) as EvaluationReport;
    } catch {
      return null;
    }
  }, [data]);

  if (!report) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Invalid judges.json
      </div>
    );
  }

  const acceptanceRate = calculateAcceptanceRate(report);

  const sortedScores = report.stats
    .filter((s): s is CaseScore => s.type === "case_score")
    .sort((a, b) => (getScore(a) ?? 0) - (getScore(b) ?? 0));

  return (
    <div className="h-full space-y-4 overflow-auto p-6">
      <h2 className="font-semibold text-lg">LLM Judge Scores</h2>

      {acceptanceRate && (
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
      )}

      <div className="space-y-2">
        {sortedScores.map((score) => (
          <div key={score.case_id}>
            <button
              className="flex w-full items-center justify-between rounded-md border p-3 text-left transition-colors hover:bg-muted/50"
              onClick={() =>
                setExpandedScoreId(
                  expandedScoreId === score.case_id ? null : score.case_id
                )
              }
              type="button"
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
            {expandedScoreId === score.case_id && (
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
        ))}
      </div>
    </div>
  );
}
