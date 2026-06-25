"use client";

import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import {
  calculateAcceptanceRate,
  sortJudgeFeedbackItemsByScore,
} from "@repo/app/documents/lib/evaluation-utils";
import { EvaluationSectionView } from "./evaluation-section-view";
import { JudgeResultCard } from "./judge-result-card";

type EvaluationSectionProps = {
  judgeItems: JudgeFeedbackItem[] | null;
  documentId?: string;
  title?: string;
  emptyMessage?: string;
  defaultOpen?: boolean;
};

export function EvaluationSection({
  judgeItems,
  documentId,
  title = "Evaluation",
  emptyMessage = "Awaiting LLM Judges feedback",
  defaultOpen = false,
}: EvaluationSectionProps) {
  const { acceptedCount, totalCount } = calculateAcceptanceRate(
    judgeItems ?? undefined
  );
  let state: "awaiting" | "empty" | "ready" = "ready";

  if (judgeItems === null) {
    state = "awaiting";
  } else if (judgeItems.length === 0) {
    state = "empty";
  }

  return (
    <EvaluationSectionView
      acceptedCount={acceptedCount}
      awaitingMessage={emptyMessage}
      defaultOpen={defaultOpen}
      emptyMessage="No judges have been evaluated yet"
      state={state}
      title={title}
      totalCount={totalCount}
    >
      {judgeItems?.length
        ? sortJudgeFeedbackItemsByScore(judgeItems).map((item) => (
            <JudgeResultCard
              documentId={documentId}
              item={item}
              key={item.judgeScoreId}
            />
          ))
        : null}
    </EvaluationSectionView>
  );
}
