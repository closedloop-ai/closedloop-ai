"use client";

import { CollapsibleSection } from "@repo/design-system/components/ui/collapsible-section";
import { Progress } from "@repo/design-system/components/ui/progress";
import { type ReactNode, useState } from "react";

type EvaluationSectionViewProps = {
  title?: string;
  defaultOpen?: boolean;
  state: "awaiting" | "empty" | "ready";
  awaitingMessage?: string;
  emptyMessage?: string;
  acceptedCount?: number;
  totalCount?: number;
  children?: ReactNode;
};

export function EvaluationSectionView({
  title = "Evaluation",
  defaultOpen = false,
  state,
  awaitingMessage = "Awaiting LLM Judges feedback",
  emptyMessage = "No judges have been evaluated yet",
  acceptedCount = 0,
  totalCount = 0,
  children,
}: Readonly<EvaluationSectionViewProps>) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const acceptanceRate =
    totalCount > 0 ? Math.round((acceptedCount / totalCount) * 100) : 0;

  return (
    <CollapsibleSection onOpenChange={setIsOpen} open={isOpen} title={title}>
      {state === "awaiting" ? (
        <p className="text-muted-foreground text-sm">{awaitingMessage}</p>
      ) : null}
      {state === "empty" ? (
        <p className="text-muted-foreground text-sm">{emptyMessage}</p>
      ) : null}
      {state === "ready" ? (
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
          <div className="space-y-2">{children}</div>
        </div>
      ) : null}
    </CollapsibleSection>
  );
}
