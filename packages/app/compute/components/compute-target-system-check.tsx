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
import { type ReactNode, useEffect, useState } from "react";

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
  /**
   * Failing REQUIRED rows — the ones that actually block a command. Optional
   * rows never count here; they arrive as `warningCount` (ISS-5687).
   */
  failureCount?: number;
  /**
   * Failing OPTIONAL rows (the two MCP rows, chiefly). A non-blocking finding:
   * it must not be reported as a failure, and must not be silently rounded away
   * into "All checks passed" either.
   */
  warningCount?: number;
  hasResult?: boolean;
  isEligible?: boolean;
  isLoading?: boolean;
  targetName?: string;
  /**
   * Repair control, rendered beside Re-check. The surface owns the transport, so
   * this is a slot rather than a prop bundle; omitted (or null) when the shell
   * has Repair gated off, or when the gateway has nothing repairable — see
   * `SystemCheckRepairButton`, which returns null in exactly that case.
   */
  repairAction?: ReactNode;
  /** Narration of a repair run, rendered above the check rows. */
  repairPanel?: ReactNode;
  /**
   * True while a repair is running. The Repair control sits in the header but
   * its narration lives inside this collapsible, which defaults closed — so a
   * repair started from a collapsed section would report only through the badge.
   * Starting one opens the section; it is never auto-closed, so the steps stay
   * readable after the run finishes.
   */
  isRepairing?: boolean;
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
  warningCount,
  hasResult,
  isEligible,
  isLoading,
  targetName,
  repairAction,
  repairPanel,
  isRepairing = false,
}: Readonly<ComputeTargetSystemCheckProps>) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (isRepairing) {
      setOpen(true);
    }
  }, [isRepairing]);
  const resolvedHasResult = hasResult ?? content !== undefined;
  const resolvedIsEligible = isEligible ?? state !== "disabled";
  const resolvedIsLoading = isLoading ?? state === "loading";
  const resolvedState =
    state ??
    getSystemCheckState({
      failureCount,
      warningCount,
      hasResult: resolvedHasResult,
      isEligible: resolvedIsEligible,
      isLoading: resolvedIsLoading,
    });
  const resolvedSummary =
    summary ??
    getSystemCheckSummary({
      failureCount,
      warningCount,
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

          <div className="flex shrink-0 flex-wrap gap-2">
            {repairAction}
            <Button
              className="shrink-0 gap-1.5"
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
        </div>

        <CollapsibleContent className="mt-4 space-y-4 border-t pt-4">
          {repairPanel}
          {content ?? resolvedFallback}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function getSystemCheckState({
  failureCount,
  warningCount,
  hasResult,
  isEligible,
  isLoading,
}: Readonly<{
  failureCount?: number;
  warningCount?: number;
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
  // A warning is not a pass. Excluding optional rows from the failure count
  // (ISS-5687) must not promote an unconfigured MCP to a green "All checks
  // passed" — it stops being reported as a blocker, not as a finding.
  if (failureCount === 0 && !warningCount) {
    return "success";
  }
  return "warning";
}

function getSystemCheckSummary({
  failureCount,
  warningCount,
  hasResult,
  isEligible,
  isLoading,
}: Readonly<{
  failureCount?: number;
  warningCount?: number;
  hasResult: boolean;
  isEligible: boolean;
  isLoading: boolean;
}>): string {
  if (!hasResult) {
    if (isLoading) {
      return "Running system check…";
    }
    return isEligible
      ? "Awaiting first system check"
      : "System check unavailable";
  }
  const failures =
    typeof failureCount === "number" && failureCount > 0 ? failureCount : 0;
  const warnings =
    typeof warningCount === "number" && warningCount > 0 ? warningCount : 0;
  // Both are named when both stand. Collapsing to the failure count alone would
  // hide a real finding behind a more severe one — a smaller version of the
  // same omission ISS-5687 is about.
  const parts: string[] = [];
  if (failures > 0) {
    parts.push(`${failures} failure${failures === 1 ? "" : "s"}`);
  }
  if (warnings > 0) {
    parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
  }
  if (parts.length > 0) {
    return parts.join(", ");
  }
  if (failureCount === 0) {
    return "All checks passed";
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
