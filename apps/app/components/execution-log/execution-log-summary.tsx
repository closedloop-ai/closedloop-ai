"use client";

import type { ExecutionTrace } from "@repo/api/src/types/execution-log";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { AlertCircleIcon } from "lucide-react";
import { useExecutionLog } from "@/hooks/queries/use-execution-log";

type ExecutionLogSummaryProps = {
  artifactId: string;
  onViewFullTrace: (trace: ExecutionTrace, sessionId?: string) => void;
};

/**
 * Format duration from milliseconds to human-readable string
 * Examples: "2m 30s", "45s", "1m 5s", "--" for null/0
 */
function formatDuration(ms: number | null): string {
  if (!ms || ms === 0) {
    return "--";
  }

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  }

  return `${seconds}s`;
}

/**
 * ExecutionLogSummary displays a compact overview of agent execution traces
 * for a given artifact. Shows overall stats and a list of agent sessions.
 *
 * States:
 * - Loading: Skeleton matching actual content structure
 * - Error: Alert with error message
 * - Empty: Centered message explaining no logs are available
 * - Success: Stats grid + session list + "View Full Trace" button
 */
export function ExecutionLogSummary({
  artifactId,
  onViewFullTrace,
}: Readonly<ExecutionLogSummaryProps>) {
  const { data: trace, isLoading, error } = useExecutionLog(artifactId);

  // Loading state - skeleton matching actual content
  if (isLoading) {
    return (
      <div className="space-y-4">
        {/* Stats grid skeleton */}
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted/50 p-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>

        {/* Session list skeleton - 3 rows */}
        <div className="space-y-2">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>

        {/* Button skeleton */}
        <Skeleton className="h-10 w-full rounded-lg" />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircleIcon className="h-4 w-4" />
        <AlertDescription>
          {error instanceof Error
            ? error.message
            : "Failed to load execution logs"}
        </AlertDescription>
      </Alert>
    );
  }

  // Empty state - no trace data
  if (!trace || trace.totalSessions === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <h3 className="font-medium text-lg">No execution logs available</h3>
        <p className="mt-1 text-muted-foreground text-sm">
          Agent execution traces will appear here once processing begins
        </p>
      </div>
    );
  }

  // Success state - show stats and sessions
  return (
    <div className="space-y-4">
      {/* Overall stats grid */}
      <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted/50 p-3">
        <div className="space-y-1">
          <div className="text-muted-foreground text-xs">Total Sessions</div>
          <div className="font-semibold text-lg">{trace.totalSessions}</div>
        </div>
        <div className="space-y-1">
          <div className="text-muted-foreground text-xs">Messages</div>
          <div className="font-semibold text-lg">{trace.totalMessages}</div>
        </div>
        <div className="space-y-1">
          <div className="text-muted-foreground text-xs">Tool Calls</div>
          <div className="font-semibold text-lg">{trace.totalToolCalls}</div>
        </div>
        <div className="space-y-1">
          <div className="text-muted-foreground text-xs">Duration</div>
          <div className="font-semibold text-lg">
            {formatDuration(trace.overallDuration)}
          </div>
        </div>
      </div>

      {/* Agent session list */}
      <div className="space-y-2">
        {trace.sessions.map((session) => (
          <button
            className="w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/50"
            key={session.sessionId}
            onClick={() => onViewFullTrace(trace, session.sessionId)}
            type="button"
          >
            <div className="flex items-center justify-between">
              <div className="font-medium text-sm">{session.agentLabel}</div>
              <div className="text-muted-foreground text-xs">
                {formatDuration(session.stats.duration)}
              </div>
            </div>
            <div className="mt-1 flex gap-4 text-muted-foreground text-xs">
              <span>{session.stats.messageCount} messages</span>
              <span>{session.stats.toolCallCount} tool calls</span>
            </div>
          </button>
        ))}
      </div>

      {/* View Full Trace button */}
      <Button
        className="w-full"
        onClick={() => onViewFullTrace(trace)}
        variant="outline"
      >
        View Full Trace
      </Button>
    </div>
  );
}
