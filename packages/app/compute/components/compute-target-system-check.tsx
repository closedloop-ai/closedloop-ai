"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Info,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { type ReactNode, useState } from "react";

export type ComputeTargetSystemCheckState =
  | "idle"
  | "success"
  | "warning"
  | "loading"
  | "disabled";

type ComputeTargetSystemCheckProps = {
  summary?: string;
  description?: ReactNode;
  state?: ComputeTargetSystemCheckState;
  actionLabel?: string;
  onAction?: () => Promise<void> | void;
  actionDisabled?: boolean;
  content?: ReactNode;
  fallback?: ReactNode;
  defaultOpen?: boolean;
  title?: string;
  checkedAtLabel?: string;
  failureCount?: number;
  hasResult?: boolean;
  isEligible?: boolean;
  isLoading?: boolean;
  targetName?: string;
};

const BADGE_CLASS_NAMES: Record<ComputeTargetSystemCheckState, string> = {
  idle: "border-primary/20 bg-primary/5 text-primary",
  success:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warning:
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  loading: "border-primary/30 bg-primary/10 text-primary",
  disabled: "border-border bg-background/70 text-muted-foreground",
};

export function ComputeTargetSystemCheck({
  summary,
  description,
  state,
  actionLabel,
  onAction,
  actionDisabled = false,
  content,
  fallback,
  defaultOpen = false,
  title = "System Check",
  checkedAtLabel,
  failureCount,
  hasResult,
  isEligible,
  isLoading,
  targetName,
}: Readonly<ComputeTargetSystemCheckProps>) {
  const [open, setOpen] = useState(defaultOpen);
  const resolvedHasResult = hasResult ?? content !== undefined;
  const resolvedIsEligible = isEligible ?? state !== "disabled";
  const resolvedIsLoading = isLoading ?? state === "loading";
  const resolvedState =
    state ??
    getSystemCheckState({
      failureCount,
      hasResult: resolvedHasResult,
      isEligible: resolvedIsEligible,
      isLoading: resolvedIsLoading,
    });
  const resolvedSummary =
    summary ??
    getSystemCheckSummary({
      failureCount,
      hasResult: resolvedHasResult,
      isEligible: resolvedIsEligible,
      isLoading: resolvedIsLoading,
    });
  const resolvedDescription =
    description ??
    getSystemCheckDescription({
      checkedAtLabel,
      hasResult: resolvedHasResult,
      isEligible: resolvedIsEligible,
      isLoading: resolvedIsLoading,
      targetName,
    });
  const resolvedActionLabel =
    actionLabel ?? (resolvedHasResult ? "Re-check" : "Run check");
  const resolvedFallback =
    fallback ??
    (resolvedIsEligible ? (
      <p className="text-muted-foreground text-sm">
        Run a system check to inspect this compute target.
      </p>
    ) : (
      <p className="text-muted-foreground text-sm">
        System checks are available when this compute target is online.
      </p>
    ));

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <div className="-mx-3 mt-3 border-t bg-muted/15 px-4 py-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <CollapsibleTrigger className="group flex min-w-0 items-start gap-3 rounded-sm text-left">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/55 text-muted-foreground transition-colors group-hover:bg-muted group-hover:text-foreground">
              <ChevronDown className="size-4 transition-transform group-data-[state=closed]:-rotate-90" />
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <SystemCheckStatusIcon state={resolvedState} />
                <p className="font-medium text-sm">{title}</p>
                <Badge
                  className={`h-6 rounded-md px-2 font-medium text-xs tabular-nums ${BADGE_CLASS_NAMES[resolvedState]}`}
                  variant="outline"
                >
                  {resolvedSummary}
                </Badge>
              </div>
              <div className="text-muted-foreground text-sm">
                {resolvedDescription}
              </div>
            </div>
          </CollapsibleTrigger>

          <Button
            className="w-full shrink-0 gap-1.5 md:w-auto"
            disabled={actionDisabled}
            onClick={(event) => {
              event.stopPropagation();
              onAction?.();
            }}
            size="sm"
            variant="outline"
          >
            <RefreshCw
              className={`size-3.5 ${resolvedIsLoading ? "animate-spin" : ""}`}
            />
            {resolvedActionLabel}
          </Button>
        </div>

        <CollapsibleContent className="mt-4 border-t pt-4">
          {content ?? resolvedFallback}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function getSystemCheckState({
  failureCount,
  hasResult,
  isEligible,
  isLoading,
}: Readonly<{
  failureCount?: number;
  hasResult: boolean;
  isEligible: boolean;
  isLoading: boolean;
}>): ComputeTargetSystemCheckState {
  if (isLoading) {
    return "loading";
  }
  if (!isEligible) {
    return "disabled";
  }
  if (!hasResult) {
    return "idle";
  }
  if (failureCount === 0) {
    return "success";
  }
  return "warning";
}

function getSystemCheckSummary({
  failureCount,
  hasResult,
  isEligible,
  isLoading,
}: Readonly<{
  failureCount?: number;
  hasResult: boolean;
  isEligible: boolean;
  isLoading: boolean;
}>): string {
  if (!hasResult) {
    if (isLoading) {
      return "Running system check...";
    }
    return isEligible
      ? "Awaiting first system check"
      : "System check unavailable";
  }
  if (failureCount === 0) {
    return "All checks passed";
  }
  if (typeof failureCount === "number" && failureCount > 0) {
    return `${failureCount} failure${failureCount === 1 ? "" : "s"}`;
  }
  return "Check completed";
}

function getSystemCheckDescription({
  checkedAtLabel,
  hasResult,
  isEligible,
  isLoading,
  targetName,
}: Readonly<{
  checkedAtLabel?: string;
  hasResult: boolean;
  isEligible: boolean;
  isLoading: boolean;
  targetName?: string;
}>): string {
  if (hasResult) {
    return checkedAtLabel
      ? `Last checked ${checkedAtLabel}`
      : "System check completed.";
  }
  if (isLoading) {
    return targetName ? `Checking ${targetName}.` : "Running system check.";
  }
  if (isEligible) {
    return targetName
      ? `Run a check for ${targetName}.`
      : "Run a system check.";
  }
  return "System checks require this compute target to be online.";
}

function SystemCheckStatusIcon({
  state,
}: Readonly<{ state: ComputeTargetSystemCheckState }>) {
  switch (state) {
    case "loading":
      return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
    case "success":
      return <CheckCircle2 className="size-4 text-emerald-500" />;
    case "warning":
      return <AlertCircle className="size-4 text-amber-500" />;
    default:
      return <Info className="size-4 text-muted-foreground" />;
  }
}
