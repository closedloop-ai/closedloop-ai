"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import type { MetricStatistics } from "@/types/evaluation";

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
 * Get visual styling and label based on mean score:
 * - score = 1 (Poor): destructive red styling
 * - score = 2 (Needs Improvement): warning yellow styling
 * - score = 3 (Great): success green styling
 */
function getScoreConfig(score: number): ScoreStyles {
  switch (score) {
    case 1:
      return {
        border: "border-red-200 dark:border-red-900",
        background: "bg-red-50 dark:bg-red-950/30",
        text: "text-red-700 dark:text-red-300",
        label: "Poor",
      };
    case 2:
      return {
        border: "border-yellow-200 dark:border-yellow-900",
        background: "bg-yellow-50 dark:bg-yellow-950/30",
        text: "text-yellow-700 dark:text-yellow-300",
        label: "Needs Improvement",
      };
    default:
      return {
        border: "border-green-200 dark:border-green-900",
        background: "bg-green-50 dark:bg-green-950/30",
        text: "text-green-700 dark:text-green-300",
        label: "Great",
      };
  }
}

/**
 * Display a single judge evaluation result with expand/collapse functionality.
 *
 * Shows the judge name (metric_name), mean score with visual styling,
 * and expandable justification text.
 *
 * Score-based styling:
 * - 1 (Poor): Red border and background
 * - 2 (Needs Improvement): Yellow border and background
 * - 3 (Great): Green border and background
 *
 * Usage:
 * ```tsx
 * <JudgeResultCard metric={metricStatistics} />
 * ```
 */
export function JudgeResultCard({ metric }: JudgeResultCardProps) {
  const config = getScoreConfig(metric.mean);
  const justificationText = metric.justification?.[0];

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
              Score: {metric.mean} ({config.label})
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
