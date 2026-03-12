"use client";

import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
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
  sortJudgeFeedbackItemsByScore,
} from "@/lib/evaluation-utils";
import { JudgeResultCard } from "./judge-result-card";

type EvaluationSectionProps = {
  judgeItems: JudgeFeedbackItem[] | null;
  artifactId?: string;
  title?: string;
  emptyMessage?: string;
};

export function EvaluationSection({
  judgeItems,
  artifactId,
  title = "Evaluation",
  emptyMessage = "Awaiting LLM Judges feedback",
}: EvaluationSectionProps) {
  const [isOpen, setIsOpen] = useState(false);

  const {
    acceptedCount,
    totalCount,
    rate: acceptanceRate,
  } = calculateAcceptanceRate(judgeItems ?? undefined);

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
        {judgeItems === null && (
          <p className="text-muted-foreground text-sm">{emptyMessage}</p>
        )}
        {judgeItems !== null && judgeItems.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No judges have been evaluated yet
          </p>
        )}
        {judgeItems !== null && judgeItems.length > 0 && (
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
              {sortJudgeFeedbackItemsByScore(judgeItems).map((item) => (
                <JudgeResultCard
                  artifactId={artifactId}
                  item={item}
                  key={item.judgeScoreId}
                />
              ))}
            </div>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
