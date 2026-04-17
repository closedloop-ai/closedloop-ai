"use client";

import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import { Progress } from "@repo/design-system/components/ui/progress";
import { useState } from "react";
import {
  calculateAcceptanceRate,
  sortJudgeFeedbackItemsByScore,
} from "@/lib/evaluation-utils";
import { CollapsibleSection } from "./collapsible-section";
import { JudgeResultCard } from "./judge-result-card";

type EvaluationSectionProps = {
  judgeItems: JudgeFeedbackItem[] | null;
  documentId?: string;
  title?: string;
  emptyMessage?: string;
};

export function EvaluationSection({
  judgeItems,
  documentId,
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
    <CollapsibleSection onOpenChange={setIsOpen} open={isOpen} title={title}>
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
              <span className="font-medium">{acceptanceRate.toFixed(0)}%</span>
            </div>
            <Progress className="h-2" value={acceptanceRate} />
          </div>

          <div className="space-y-2">
            {sortJudgeFeedbackItemsByScore(judgeItems).map((item) => (
              <JudgeResultCard
                documentId={documentId}
                item={item}
                key={item.judgeScoreId}
              />
            ))}
          </div>
        </div>
      )}
    </CollapsibleSection>
  );
}
