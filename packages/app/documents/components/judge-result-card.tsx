"use client";

import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import { hasAtMostDecimalPlaces } from "@repo/api/src/utils/math";
import { formatScorePercent } from "@repo/app/documents/lib/evaluation-utils";
import { useMyJudgeRatings } from "@repo/app/judges-analytics/hooks/use-my-judge-ratings";
import { useSubmitJudgeRating } from "@repo/app/judges-analytics/hooks/use-submit-judge-rating";
import { useCallback, useEffect, useMemo, useState } from "react";
import { JudgeResultCardView } from "./judge-result-card-view";

type JudgeResultCardProps = {
  item: JudgeFeedbackItem;
  documentId?: string;
  defaultOpen?: boolean;
};

export function JudgeResultCard({
  item,
  documentId,
  defaultOpen = false,
}: JudgeResultCardProps) {
  const isEditable = documentId !== undefined;
  const { data: ratingsData } = useMyJudgeRatings(documentId ?? "", {
    enabled: isEditable,
  });
  const submitRating = useSubmitJudgeRating(documentId ?? "");

  const existingRating = useMemo(() => {
    if (!(isEditable && ratingsData)) {
      return undefined;
    }
    return ratingsData.ratings.find(
      (r) => r.judgeScoreId === item.judgeScoreId
    );
  }, [isEditable, item.judgeScoreId, ratingsData]);

  const effectiveScore = existingRating?.rating ?? item.score;
  const [inputValue, setInputValue] = useState(String(effectiveScore));
  const [validationError, setValidationError] = useState<string | null>(null);
  const [lastSubmittedValue, setLastSubmittedValue] = useState(effectiveScore);

  useEffect(() => {
    setInputValue(String(effectiveScore));
    setLastSubmittedValue(effectiveScore);
  }, [effectiveScore]);

  const handleBlur = useCallback(() => {
    if (!isEditable) {
      return;
    }
    if (submitRating.isPending) {
      return;
    }

    const parsed = Number.parseFloat(inputValue);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
      setValidationError("Must be between 0 and 1");
      return;
    }
    if (!hasAtMostDecimalPlaces(parsed, 2)) {
      setValidationError("Must have at most 2 decimal places");
      return;
    }
    setValidationError(null);

    if (parsed === lastSubmittedValue) {
      return;
    }

    submitRating
      .mutateAsync({
        judgeScoreId: item.judgeScoreId,
        rating: parsed,
      })
      .then(() => {
        setLastSubmittedValue(parsed);
      })
      .catch(() => {
        setInputValue(String(lastSubmittedValue));
      });
  }, [
    inputValue,
    isEditable,
    item.judgeScoreId,
    lastSubmittedValue,
    submitRating,
  ]);
  const displayName = item.metricName || item.promptName || item.caseId;

  return (
    <JudgeResultCardView
      defaultOpen={defaultOpen}
      editable={isEditable}
      inputValue={inputValue}
      isSaving={submitRating.isPending}
      justification={item.justification}
      onInputBlur={handleBlur}
      onInputChange={(value) => {
        setInputValue(value);
        setValidationError(null);
      }}
      score={effectiveScore}
      scoreLabel={formatScorePercent(effectiveScore)}
      threshold={item.threshold}
      title={displayName}
      validationError={validationError}
    />
  );
}
