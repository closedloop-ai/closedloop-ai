"use client";

import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import { hasAtMostDecimalPlaces } from "@repo/api/src/utils/math";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { Input } from "@repo/design-system/components/ui/input";
import { ChevronDown, Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMyJudgeRatings } from "@/hooks/queries/use-my-judge-ratings";
import { useSubmitJudgeRating } from "@/hooks/queries/use-submit-judge-rating";
import { formatScorePercent } from "@/lib/evaluation-utils";

type JudgeResultCardProps = {
  item: JudgeFeedbackItem;
  artifactId?: string;
};

type ScoreStyles = {
  border: string;
  background: string;
  text: string;
  label: string;
};

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

export function JudgeResultCard({ item, artifactId }: JudgeResultCardProps) {
  const isEditable = artifactId !== undefined;
  const { data: ratingsData } = useMyJudgeRatings(artifactId ?? "", {
    enabled: isEditable,
  });
  const submitRating = useSubmitJudgeRating(artifactId ?? "");

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

  const isPassing = effectiveScore >= item.threshold;
  const config = getScoreConfig(isPassing);
  const displayName = item.promptName ?? item.caseId;

  return (
    <Collapsible
      className={`rounded-lg border ${config.border} ${config.background} p-3`}
    >
      <div className="flex items-start justify-between gap-3">
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-3 text-left hover:opacity-80">
          <ChevronDown className="h-4 w-4 transition-transform group-data-[state=closed]:-rotate-90" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-medium text-sm">{displayName}</span>
            <span className={`font-semibold text-xs ${config.text}`}>
              Score: {formatScorePercent(effectiveScore)} ({config.label})
            </span>
          </div>
        </CollapsibleTrigger>
        {isEditable ? (
          <div className="flex shrink-0 items-center gap-2">
            <Input
              className="h-8 w-20 text-right text-sm"
              max={1}
              min={0}
              onBlur={handleBlur}
              onChange={(event) => {
                setInputValue(event.target.value);
                setValidationError(null);
              }}
              onClick={(event) => {
                event.stopPropagation();
              }}
              step={0.01}
              type="number"
              value={inputValue}
            />
            {submitRating.isPending ? (
              <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : null}
          </div>
        ) : null}
      </div>
      {validationError ? (
        <p className="mt-2 text-destructive text-xs">{validationError}</p>
      ) : null}
      <CollapsibleContent>
        {item.justification ? (
          <div className="mt-2 ml-7 space-y-1 text-muted-foreground text-sm">
            <p className="font-medium text-xs uppercase tracking-wide">
              Reasoning
            </p>
            <p className="whitespace-pre-wrap">{item.justification}</p>
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
