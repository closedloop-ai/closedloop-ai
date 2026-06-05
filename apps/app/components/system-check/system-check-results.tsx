"use client";

import { cn } from "@repo/design-system/lib/utils";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { CheckResult } from "@/lib/engineer/queries/health-check";

type SystemCheckResultsProps = {
  checks?: CheckResult[];
  isLoading?: boolean;
  revealedCount?: number;
  className?: string;
  afterRequired?: ReactNode;
};

export function SystemCheckResults({
  checks,
  isLoading = false,
  revealedCount,
  className,
  afterRequired,
}: Readonly<SystemCheckResultsProps>) {
  const requiredChecks = checks?.filter((check) => check.required) ?? [];
  const optionalChecks = checks?.filter((check) => !check.required) ?? [];
  const visibleCount = revealedCount ?? Number.POSITIVE_INFINITY;
  const requiredCount = requiredChecks.length;

  return (
    <div className={cn("space-y-4", className)}>
      <div>
        <h4 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
          Required
        </h4>
        <div className="space-y-1.5">
          {requiredChecks.map((check, index) => (
            <SystemCheckRow
              check={check}
              key={check.id}
              revealed={visibleCount > index}
            />
          ))}
          {isLoading &&
            Array.from({ length: 6 }).map((_, index) => (
              <SystemCheckRowSkeleton
                key={`required-skeleton-${String(index)}`}
              />
            ))}
        </div>
      </div>

      {afterRequired}

      <div>
        <h4 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
          Optional
        </h4>
        <div className="space-y-1.5">
          {optionalChecks.map((check, index) => (
            <SystemCheckRow
              check={check}
              key={check.id}
              revealed={visibleCount > requiredCount + index}
            />
          ))}
          {isLoading &&
            Array.from({ length: 2 }).map((_, index) => (
              <SystemCheckRowSkeleton
                key={`optional-skeleton-${String(index)}`}
              />
            ))}
        </div>
      </div>
    </div>
  );
}

function SystemCheckRow({
  check,
  revealed,
}: Readonly<{ check: CheckResult; revealed: boolean }>) {
  if (!revealed) {
    return <SystemCheckRowSkeleton />;
  }

  return (
    <div className="fade-in slide-in-from-left-3 animate-in space-y-0.5 duration-300">
      <div className="flex items-center gap-2 text-sm">
        <SystemCheckIcon passed={check.passed} required={check.required} />
        <span className="flex-1 truncate">{check.label}</span>
        {check.passed && check.version && (
          <span className="font-mono text-muted-foreground text-xs">
            {check.version}
          </span>
        )}
        {check.passed && !check.version && (
          <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
        )}
        {!check.passed && (
          <span className="text-muted-foreground text-xs">{check.error}</span>
        )}
      </div>
      {!check.passed && check.remediation && (
        <p className="pl-6 text-muted-foreground text-xs">
          <span className="select-all font-mono text-[11px]">
            {check.remediation}
          </span>
        </p>
      )}
    </div>
  );
}

function SystemCheckIcon({
  passed,
  required,
}: Readonly<{ passed: boolean; required: boolean }>) {
  if (passed) {
    return <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />;
  }
  if (required) {
    return <XCircle className="size-4 shrink-0 text-destructive" />;
  }
  return <AlertTriangle className="size-4 shrink-0 text-amber-500" />;
}

function SystemCheckRowSkeleton() {
  return (
    <div className="flex items-center gap-2 text-sm">
      <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
      <div className="h-4 w-24 animate-pulse rounded bg-muted" />
    </div>
  );
}
