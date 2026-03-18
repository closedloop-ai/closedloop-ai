"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useIsFetching, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Info,
  Laptop,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { type MouseEvent, useState } from "react";
import { SystemCheckResults } from "@/components/system-check/system-check-results";
import {
  useComputeTargets,
  useDeleteComputeTarget,
} from "@/hooks/queries/use-compute-targets";
import {
  COMPUTE_TARGETS_QUERY_OPTIONS,
  DESKTOP_SETUP_URL,
} from "@/lib/engineer/constants";
import type { CheckResult } from "@/lib/engineer/queries/health-check";
import { healthCheckOptions } from "@/lib/engineer/queries/health-check";
import { queryKeys } from "@/lib/engineer/queries/keys";
import { useSystemCheckEligibility } from "@/lib/system-check/use-system-check-eligibility";

function formatLastSeen(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function formatLastChecked(value: number): string {
  if (value <= 0) {
    return "Not run yet";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function getFailureCount(checks: CheckResult[] | undefined): number {
  return checks?.filter((check) => !check.passed).length ?? 0;
}

function getSystemCheckSummary(
  checks: CheckResult[] | undefined,
  isFetching: boolean,
  isEligible: boolean
): string {
  if (!checks?.length) {
    if (isFetching) {
      return "Running system check...";
    }
    return isEligible
      ? "Awaiting first system check"
      : "System check unavailable";
  }

  const failureCount = getFailureCount(checks);
  return failureCount === 0
    ? "All checks passed"
    : `${failureCount} failure${failureCount === 1 ? "" : "s"}`;
}

function getStatusDescription(
  hasHealthCheckResult: boolean,
  dataUpdatedAt: number,
  shouldRunSystemCheck: boolean
): string {
  if (hasHealthCheckResult) {
    return `Last checked ${formatLastChecked(dataUpdatedAt)}`;
  }

  if (shouldRunSystemCheck) {
    return "Checks run automatically for the active execution target.";
  }

  return "Select an online relay target or connect via the desktop client to enable system checks.";
}

function renderStatusIcon({
  hasHealthCheckResult,
  hasPassingResult,
  isHealthCheckFetching,
  systemCheckLoading,
}: {
  hasHealthCheckResult: boolean;
  hasPassingResult: boolean;
  isHealthCheckFetching: boolean;
  systemCheckLoading: boolean;
}) {
  if (isHealthCheckFetching || systemCheckLoading) {
    return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  }

  if (hasPassingResult) {
    return <CheckCircle2 className="size-4 text-emerald-500" />;
  }

  if (hasHealthCheckResult) {
    return <AlertCircle className="size-4 text-amber-500" />;
  }

  return <Info className="size-4 text-muted-foreground" />;
}

export function LocalComputeTargetsCard() {
  const [systemCheckOpen, setSystemCheckOpen] = useState(false);
  const { data: targets = [], isLoading } = useComputeTargets({
    ...COMPUTE_TARGETS_QUERY_OPTIONS,
  });
  const deleteTarget = useDeleteComputeTarget();
  const { isLoading: systemCheckLoading, shouldRunSystemCheck } =
    useSystemCheckEligibility();
  const {
    data: healthCheckData,
    dataUpdatedAt,
    refetch: refetchHealthCheck,
  } = useQuery({
    ...healthCheckOptions(),
    enabled: false,
  });
  const isHealthCheckFetching =
    useIsFetching({ queryKey: queryKeys.healthCheck() }) > 0;

  const handleDelete = (id: string, machineName: string) => {
    deleteTarget.mutate(id, {
      onSuccess: () => toast.success(`Removed ${machineName}`),
    });
  };

  const handleRecheck = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();

    if (!shouldRunSystemCheck) {
      return;
    }

    await refetchHealthCheck();
  };

  const failureCount = getFailureCount(healthCheckData?.checks);
  const summary = getSystemCheckSummary(
    healthCheckData?.checks,
    isHealthCheckFetching,
    shouldRunSystemCheck
  );
  const hasHealthCheckResult = healthCheckData !== undefined;
  const hasPassingResult = healthCheckData !== undefined && failureCount === 0;
  const statusDescription = getStatusDescription(
    hasHealthCheckResult,
    dataUpdatedAt,
    shouldRunSystemCheck
  );

  let content: React.ReactNode;
  if (isLoading) {
    content = (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  } else if (targets.length === 0) {
    content = (
      <div className="space-y-3 rounded-lg border border-dashed p-4">
        <p className="text-sm">No compute targets registered yet.</p>
        <p className="text-muted-foreground text-sm">
          Install the ClosedLoop Desktop client, then connect with an API key
          from{" "}
          <Link className="underline" href="/settings?tab=api-keys">
            Settings - API Keys
          </Link>
          .
        </p>
        <a
          className="inline-flex text-primary text-sm underline"
          href={DESKTOP_SETUP_URL}
          rel="noreferrer"
          target="_blank"
        >
          Open desktop setup instructions
        </a>
      </div>
    );
  } else {
    content = (
      <div className="space-y-3">
        {targets.map((target) => (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            key={target.id}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate font-medium">{target.machineName}</p>
                <Badge
                  className="capitalize"
                  variant={target.isOnline ? "default" : "secondary"}
                >
                  {target.isOnline ? "online" : "offline"}
                </Badge>
              </div>
              <p className="text-muted-foreground text-xs">
                {target.platform} - Last seen{" "}
                {formatLastSeen(target.lastSeenAt)}
              </p>
            </div>

            <Button
              disabled={deleteTarget.isPending}
              onClick={() => handleDelete(target.id, target.machineName)}
              size="sm"
              variant="outline"
            >
              {deleteTarget.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              Delete
            </Button>
          </div>
        ))}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Laptop className="h-5 w-5" />
          Local Compute Targets
        </CardTitle>
        <CardDescription>
          Manage desktop clients connected to your account for local agent job
          execution.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {content}

        <div className="border-border/70 border-t pt-6">
          <Collapsible onOpenChange={setSystemCheckOpen} open={systemCheckOpen}>
            <div className="rounded-lg border bg-muted/20">
              <div className="flex items-start justify-between gap-3 p-4">
                <CollapsibleTrigger className="group flex min-w-0 flex-1 items-start gap-3 text-left">
                  <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      {renderStatusIcon({
                        hasHealthCheckResult,
                        hasPassingResult,
                        isHealthCheckFetching,
                        systemCheckLoading,
                      })}
                      <p className="font-medium text-sm">System Check</p>
                    </div>
                    <p className="text-sm">{summary}</p>
                    <p className="text-muted-foreground text-xs">
                      {statusDescription}
                    </p>
                  </div>
                </CollapsibleTrigger>

                <Button
                  className="shrink-0 gap-1.5"
                  disabled={
                    !shouldRunSystemCheck ||
                    systemCheckLoading ||
                    isHealthCheckFetching
                  }
                  onClick={handleRecheck}
                  size="sm"
                  variant="outline"
                >
                  <RefreshCw
                    className={`size-3.5 ${isHealthCheckFetching ? "animate-spin" : ""}`}
                  />
                  Re-check
                </Button>
              </div>

              <CollapsibleContent className="border-border/70 border-t px-4 pb-4">
                <div className="pt-4">
                  {healthCheckData ? (
                    <SystemCheckResults checks={healthCheckData.checks} />
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      {shouldRunSystemCheck
                        ? "Waiting for the first system check result."
                        : "System checks are available when the desktop client is connected."}
                    </p>
                  )}
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>
        </div>
      </CardContent>
    </Card>
  );
}
