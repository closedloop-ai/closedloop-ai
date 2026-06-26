"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { Input } from "@repo/design-system/components/ui/input";
import { ChevronDown, Loader2Icon } from "lucide-react";

type JudgeResultCardViewProps = {
  title: string;
  score: number;
  threshold: number;
  scoreLabel: string;
  justification?: string | null;
  defaultOpen?: boolean;
  editable?: boolean;
  inputValue?: string;
  validationError?: string | null;
  isSaving?: boolean;
  onInputChange?: (value: string) => void;
  onInputBlur?: () => void;
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
    text: "text-destructive",
    label: "Failing",
  };
}

export function JudgeResultCardView({
  title,
  score,
  threshold,
  scoreLabel,
  justification,
  defaultOpen = false,
  editable = false,
  inputValue,
  validationError,
  isSaving = false,
  onInputChange,
  onInputBlur,
}: Readonly<JudgeResultCardViewProps>) {
  const isPassing = score >= threshold;
  const config = getScoreConfig(isPassing);

  return (
    <Collapsible
      className={`rounded-lg border ${config.border} ${config.background} p-3`}
      defaultOpen={defaultOpen}
    >
      <div className="flex items-start justify-between gap-3">
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-3 text-left hover:opacity-80">
          <ChevronDown className="h-4 w-4 transition-transform group-data-[state=closed]:-rotate-90" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-medium text-sm">{title}</span>
            <span className={`font-semibold text-xs ${config.text}`}>
              Score: {scoreLabel} ({config.label})
            </span>
          </div>
        </CollapsibleTrigger>
        {editable ? (
          <div className="flex shrink-0 items-center gap-2">
            <Input
              className="h-8 w-20 text-right text-sm"
              max={1}
              min={0}
              onBlur={onInputBlur}
              onChange={(event) => onInputChange?.(event.target.value)}
              onClick={(event) => {
                event.stopPropagation();
              }}
              step={0.01}
              type="number"
              value={inputValue}
            />
            {isSaving ? (
              <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : null}
          </div>
        ) : null}
      </div>
      {validationError ? (
        <p className="mt-2 text-destructive text-xs">{validationError}</p>
      ) : null}
      <CollapsibleContent>
        {justification ? (
          <div className="mt-2 ml-7 space-y-1 text-muted-foreground text-sm">
            <p className="font-medium text-xs uppercase tracking-wide">
              Reasoning
            </p>
            <p className="whitespace-pre-wrap">{justification}</p>
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
