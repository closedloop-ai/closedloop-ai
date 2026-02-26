"use client";

import type { JudgesReport } from "@repo/api/src/types/evaluation";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { Progress } from "@repo/design-system/components/ui/progress";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useState } from "react";
import {
  calculateAcceptanceRate,
  sortMetricsByScore,
} from "@/lib/evaluation-utils";
import { JudgeResultCard } from "./judge-result-card";

type EvaluationSectionProps = {
  judgesReport: JudgesReport | null;
  title?: string;
  emptyMessage?: string;
};

export function EvaluationSection({
  judgesReport,
  title = "Evaluation",
  emptyMessage = "Awaiting LLM Judges feedback",
}: EvaluationSectionProps) {
  const [isOpen, setIsOpen] = useState(false);

  const allMetrics =
    judgesReport?.stats.flatMap((caseScore) => caseScore.metrics) ?? [];
  const {
    acceptedCount,
    totalCount,
    rate: acceptanceRate,
  } = calculateAcceptanceRate(allMetrics);

  return (
    <Collapsible onOpenChange={setIsOpen} open={isOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg p-3 font-medium text-sm transition-colors hover:bg-accent">
        <span>{title}</span>
        {isOpen ? (
          <ChevronUpIcon className="h-4 w-4" />
        ) : (
          <ChevronDownIcon className="h-4 w-4" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 px-3 pb-3">
        {judgesReport === null && (
          <p className="text-muted-foreground text-sm">{emptyMessage}</p>
        )}
        {judgesReport !== null && judgesReport.stats.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No judges have been evaluated yet
          </p>
        )}
        {judgesReport !== null && judgesReport.stats.length > 0 && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  {acceptedCount}/{totalCount} judges accepted
                </span>
                <span className="font-medium">
                  {acceptanceRate.toFixed(0)}%
                </span>
              </div>
              <Progress className="h-2" value={acceptanceRate} />
            </div>

            <div className="space-y-2">
              {judgesReport.stats.map((caseScore) =>
                sortMetricsByScore(caseScore.metrics).map((metric) => (
                  <JudgeResultCard
                    key={`${caseScore.case_id}-${metric.metric_name}`}
                    metric={metric}
                  />
                ))
              )}
            </div>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
