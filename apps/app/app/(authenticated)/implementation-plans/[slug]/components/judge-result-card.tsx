"use client";

import type { MetricStatistics } from "@repo/api/src/types/evaluation";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { ChevronDown } from "lucide-react";

type JudgeResultCardProps = {
  /**
   * Metric statistics containing judge name, score, and justifications
   */
  metric: MetricStatistics;
};

type ScoreStyles = {
  border: string;
  background: string;
  text: string;
  label: string;
};

/**
 * Get visual styling and label based on whether score meets threshold:
 * - score >= threshold (Passing): success green styling
 * - score < threshold (Failing): destructive red styling
 */
function getScoreConfig(isPassing: boolean): ScoreStyles {
  if (isPassing) {
    return {
      border: "border-success",
      background: "bg-success/10",
      text: "text-success-foreground",
      label: "Passing",
    };
  }
  return {
    border: "border-destructive",
    background: "bg-destructive/10",
    text: "text-destructive-foreground",
    label: "Failing",
  };
}

/**
 * Display a single judge evaluation result with expand/collapse functionality.
 *
 * Shows the judge name (metric_name), score with visual styling,
 * and expandable justification text.
 *
 * Score-based styling:
 * - score >= threshold (Passing): Green border and background
 * - score < threshold (Failing): Red border and background
 *
 * Usage:
 * ```tsx
 * <JudgeResultCard metric={metricStatistics} />
 * ```
 */
export function JudgeResultCard({ metric }: JudgeResultCardProps) {
  const isPassing = metric.score >= metric.threshold;
  const config = getScoreConfig(isPassing);
  const justificationText = metric.justification;

  return (
    <Collapsible
      className={`rounded-lg border ${config.border} ${config.background} p-3`}
    >
      <CollapsibleTrigger className="group flex w-full items-center justify-between text-left hover:opacity-80">
        <div className="flex items-center gap-3">
          <ChevronDown className="h-4 w-4 transition-transform group-data-[state=closed]:-rotate-90" />
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-sm">{metric.metric_name}</span>
            <span className={`font-semibold text-xs ${config.text}`}>
              Score: {metric.score} ({config.label})
            </span>
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {justificationText ? (
          <div className="mt-2 ml-7 space-y-1 text-muted-foreground text-sm">
            <p className="font-medium text-xs uppercase tracking-wide">
              Reasoning
            </p>
            <p className="whitespace-pre-wrap">{justificationText}</p>
          </div>
        ) : (
          <div className="mt-2 ml-7 text-muted-foreground text-sm italic">
            No reasoning provided
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
