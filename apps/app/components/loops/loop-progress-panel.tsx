"use client";

import type {
  LoopEvent,
  LoopEventArtifactCreated,
  LoopEventCompleted,
  LoopEventError,
  LoopEventOutput,
  LoopEventProgress,
  LoopEventToolCall,
} from "@repo/api/src/types/loop";
import { LoopStatus } from "@repo/api/src/types/loop";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { ScrollArea } from "@repo/design-system/components/ui/scroll-area";
import { cn } from "@repo/design-system/lib/utils";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ClockIcon,
  ExternalLinkIcon,
  FileOutputIcon,
  GitPullRequestIcon,
  LoaderIcon,
  PlayIcon,
  TerminalIcon,
  TextIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLoopPolling } from "@/hooks/queries/use-loop-polling";
import {
  type StreamStatus,
  useLoopStream,
} from "@/hooks/queries/use-loop-stream";
import { formatTokenCount } from "@/lib/format-utils";

type LoopProgressPanelProps = {
  loopId: string;
  onComplete?: (status: string) => void;
};

// -- Display status derived from stream status + events -----------------------

type DisplayStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "DISCONNECTED";

function deriveDisplayStatus(
  pollingLoopStatus: LoopStatus | null,
  events: LoopEvent[],
  streamStatus: StreamStatus
): DisplayStatus {
  // 1. Terminal events in event list take highest priority
  const lastEvent = events.length > 0 ? events.at(-1) : null;
  if (lastEvent?.type === "completed") {
    return "COMPLETED";
  }
  if (lastEvent?.type === "error") {
    return "FAILED";
  }
  if (lastEvent?.type === "cancelled") {
    return "CANCELLED";
  }

  // 2. Polled loop status is authoritative (from DB, not transport state)
  if (pollingLoopStatus) {
    switch (pollingLoopStatus) {
      case LoopStatus.Completed:
        return "COMPLETED";
      case LoopStatus.Failed:
      case LoopStatus.TimedOut:
        return "FAILED";
      case LoopStatus.Cancelled:
        return "CANCELLED";
      case LoopStatus.Running:
      case LoopStatus.Claimed:
        return events.length > 0 ? "RUNNING" : "PENDING";
      default:
        return "PENDING";
    }
  }

  // 3. Fallback when polling hasn't loaded yet: infer from events + stream
  if (events.length > 0) {
    return "RUNNING";
  }
  if (streamStatus === "disconnected" || streamStatus === "error") {
    return "DISCONNECTED";
  }
  return "PENDING";
}

const displayStatusColorMap: Record<DisplayStatus, string> = {
  PENDING:
    "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800",
  RUNNING:
    "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800",
  COMPLETED:
    "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
  FAILED:
    "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800",
  CANCELLED:
    "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800",
  DISCONNECTED:
    "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700",
};

const displayStatusLabels: Record<DisplayStatus, string> = {
  PENDING: "Pending",
  RUNNING: "Running",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  DISCONNECTED: "Disconnected",
};

function isActiveDisplayStatus(displayStatus: DisplayStatus): boolean {
  return displayStatus === "PENDING" || displayStatus === "RUNNING";
}

// -- Formatting helpers -------------------------------------------------------

function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatElapsedTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

// -- Elapsed time hook --------------------------------------------------------

function useElapsedTime(startTimestamp: string | null, isRunning: boolean) {
  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!(startTimestamp && isRunning)) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    const startTime = new Date(startTimestamp).getTime();

    const tick = () => {
      setElapsed(Date.now() - startTime);
    };

    tick();
    intervalRef.current = setInterval(tick, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [startTimestamp, isRunning]);

  // When no longer running, compute final elapsed from last tick
  useEffect(() => {
    if (!isRunning && startTimestamp) {
      setElapsed(Date.now() - new Date(startTimestamp).getTime());
    }
  }, [isRunning, startTimestamp]);

  return elapsed;
}

// -- Event renderers ----------------------------------------------------------

function StartedEvent({ timestamp }: { timestamp: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30">
        <PlayIcon className="size-3 text-blue-600 dark:text-blue-400" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-sm">Agent started</div>
        <div className="text-muted-foreground text-xs">
          {formatTimestamp(timestamp)}
        </div>
      </div>
    </div>
  );
}

function OutputEvent({ event }: { event: LoopEventOutput }) {
  const [isOpen, setIsOpen] = useState(false);
  const chunk = event.chunk ?? "";
  const preview = chunk.length > 120 ? `${chunk.substring(0, 120)}...` : chunk;

  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted">
        <TextIcon className="size-3 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <Collapsible onOpenChange={setIsOpen} open={isOpen}>
          <CollapsibleTrigger asChild>
            <button
              className="flex w-full items-center gap-2 text-left text-sm transition-colors hover:text-foreground"
              type="button"
            >
              <span className="truncate text-muted-foreground">{preview}</span>
              <ChevronDownIcon
                className={cn(
                  "ml-auto size-3 shrink-0 text-muted-foreground transition-transform",
                  isOpen && "rotate-180"
                )}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-xs">
              {chunk}
            </pre>
          </CollapsibleContent>
        </Collapsible>
        {event.timestamp ? (
          <div className="mt-1 text-muted-foreground text-xs">
            {formatTimestamp(event.timestamp)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ProgressEvent({ event }: { event: LoopEventProgress }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30">
        <LoaderIcon className="size-3 animate-spin text-blue-600 dark:text-blue-400" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm">{event.stage}</div>
        {event.percent > 0 && (
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-blue-500 transition-all duration-300"
              style={{ width: `${Math.min(event.percent, 100)}%` }}
            />
          </div>
        )}
        <div className="mt-1 text-muted-foreground text-xs">
          {formatTimestamp(event.timestamp)}
        </div>
      </div>
    </div>
  );
}

function ToolCallEvent({ event }: { event: LoopEventToolCall }) {
  const isStart = event.status === "start";

  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-purple-100 dark:bg-purple-900/30">
        <TerminalIcon className="size-3 text-purple-600 dark:text-purple-400" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{event.tool}</span>
          {isStart ? (
            <LoaderIcon className="size-3 animate-spin text-muted-foreground" />
          ) : (
            <CheckCircle2Icon className="size-3 text-green-600 dark:text-green-400" />
          )}
        </div>
        <div className="mt-1 text-muted-foreground text-xs">
          {formatTimestamp(event.timestamp)}
        </div>
      </div>
    </div>
  );
}

function ArtifactCreatedEvent({ event }: { event: LoopEventArtifactCreated }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
        <FileOutputIcon className="size-3 text-green-600 dark:text-green-400" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm">
          Created artifact:{" "}
          <span className="font-medium">{event.artifactType}</span>
        </div>
        <div className="mt-1 text-muted-foreground text-xs">
          {formatTimestamp(event.timestamp)}
        </div>
      </div>
    </div>
  );
}

function CompletedEvent({ event }: { event: LoopEventCompleted }) {
  // Extract PR info from event.result (typed as JsonObject)
  const result = (event.result ?? {}) as Record<string, unknown>;
  const prUrl = typeof result.prUrl === "string" ? result.prUrl : null;
  const prNumber = typeof result.prNumber === "number" ? result.prNumber : null;
  const tokensUsed = event.tokensUsed ?? { input: 0, output: 0 };

  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
        <CheckCircle2Icon className="size-3 text-green-600 dark:text-green-400" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-green-700 text-sm dark:text-green-400">
          Completed successfully
        </div>
        {prUrl && (
          <a
            className="mt-1 inline-flex items-center gap-1.5 text-blue-600 text-xs hover:underline dark:text-blue-400"
            href={prUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            <GitPullRequestIcon className="size-3" />
            {prNumber ? `PR #${prNumber}` : "View Pull Request"}
            <ExternalLinkIcon className="size-2.5" />
          </a>
        )}
        <div className="mt-1 text-muted-foreground text-xs">
          {formatTimestamp(event.timestamp)} | Tokens:{" "}
          {formatTokenCount(tokensUsed.input)} in /{" "}
          {formatTokenCount(tokensUsed.output)} out
        </div>
      </div>
    </div>
  );
}

function ErrorEvent({ event }: { event: LoopEventError }) {
  const [logOpen, setLogOpen] = useState(false);

  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
        <AlertCircleIcon className="size-3 text-red-600 dark:text-red-400" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-red-700 text-sm dark:text-red-400">
          Error: {event.code}
        </div>
        <div className="mt-1 text-red-600 text-xs dark:text-red-300">
          {event.message}
        </div>
        {event.tokenUsage && (
          <div className="mt-1 text-muted-foreground text-xs">
            Tokens: {formatTokenCount(event.tokenUsage.inputTokens)} in /{" "}
            {formatTokenCount(event.tokenUsage.outputTokens)} out
          </div>
        )}
        {event.diagnosticsVersion && (
          <div className="mt-1 text-muted-foreground text-xs">
            Diagnostics version: {event.diagnosticsVersion}
          </div>
        )}
        {event.logTail && (
          <Collapsible
            className="mt-1"
            onOpenChange={setLogOpen}
            open={logOpen}
          >
            <CollapsibleTrigger asChild>
              <button
                className="flex items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
                type="button"
              >
                Log tail
                <ChevronDownIcon
                  className={cn(
                    "size-3 transition-transform",
                    logOpen && "rotate-180"
                  )}
                />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1">
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 text-xs">
                {event.logTail}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
        <div className="mt-1 text-muted-foreground text-xs">
          {formatTimestamp(event.timestamp)}
        </div>
      </div>
    </div>
  );
}

function CancelledEvent({ reason }: { reason?: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-orange-100 dark:bg-orange-900/30">
        <AlertCircleIcon className="size-3 text-orange-600 dark:text-orange-400" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-orange-700 text-sm dark:text-orange-400">
          Cancelled
        </div>
        {reason ? (
          <div className="mt-1 text-orange-600 text-xs dark:text-orange-300">
            {reason}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function EventItem({ event }: { event: LoopEvent }) {
  switch (event.type) {
    case "started":
      return <StartedEvent timestamp={event.timestamp} />;
    case "output":
      return <OutputEvent event={event} />;
    case "progress":
      return <ProgressEvent event={event} />;
    case "tool_call":
      return <ToolCallEvent event={event} />;
    case "artifact_created":
      return <ArtifactCreatedEvent event={event} />;
    case "completed":
      return <CompletedEvent event={event} />;
    case "error":
      return <ErrorEvent event={event} />;
    case "cancelled":
      return <CancelledEvent reason={event.reason} />;
    default:
      return null;
  }
}

// -- Main component -----------------------------------------------------------

export function LoopProgressPanel({
  loopId,
  onComplete,
}: Readonly<LoopProgressPanelProps>) {
  const stream = useLoopStream(loopId);
  // Always poll — polled events are the authoritative source (full history from DB).
  // SSE provides real-time events between poll cycles.
  const polling = useLoopPolling(loopId);

  // Merge: polled events are the base (full DB history).
  // Append any stream events with timestamps after the last polled event,
  // giving real-time updates in the gap between poll cycles.
  const events = useMemo(() => {
    const polled = polling.events;
    const streamed = stream.events;

    if (streamed.length === 0) {
      return polled;
    }
    if (polled.length === 0) {
      return streamed;
    }

    const lastPolledTs = polled.at(-1)?.timestamp ?? "";
    const newFromStream = streamed.filter(
      (e) => (e.timestamp ?? "") > lastPolledTs
    );

    return newFromStream.length > 0 ? [...polled, ...newFromStream] : polled;
  }, [polling.events, stream.events]);

  const isComplete = stream.isComplete || polling.isComplete;
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const hasCalledOnComplete = useRef(false);

  // Derive display status from authoritative loop state, then events, then stream transport
  const displayStatus = deriveDisplayStatus(
    polling.loopStatus,
    events,
    stream.status
  );
  const active = isActiveDisplayStatus(displayStatus);

  // Derive token totals from completed event, or fall back to error event diagnostics
  const completedEvent = events.find(
    (e): e is LoopEventCompleted => e.type === "completed"
  );
  const errorEvent = events.find(
    (e): e is LoopEventError => e.type === "error"
  );
  const tokensInput =
    completedEvent?.tokensUsed?.input ??
    errorEvent?.tokenUsage?.inputTokens ??
    polling.loopTokensInput;
  const tokensOutput =
    completedEvent?.tokensUsed?.output ??
    errorEvent?.tokenUsage?.outputTokens ??
    polling.loopTokensOutput;

  // Derive start timestamp from first event
  const startTimestamp =
    events.length > 0 ? (events[0].timestamp ?? null) : null;
  const elapsed = useElapsedTime(startTimestamp, active);

  // Auto-scroll to bottom as events arrive.
  // events.length is intentionally listed as a dependency so the scroll fires
  // whenever new events are appended, even though the linter considers it extra.
  const scrollToBottom = useCallback(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: events.length triggers scroll on new events
  useEffect(() => {
    scrollToBottom();
  }, [events.length, scrollToBottom]);

  // Fire onComplete callback once when the loop finishes
  useEffect(() => {
    if (isComplete && !hasCalledOnComplete.current) {
      hasCalledOnComplete.current = true;
      onComplete?.(displayStatus);
    }
  }, [isComplete, displayStatus, onComplete]);

  return (
    <Card className="flex h-full flex-col gap-0 py-0">
      {/* Header */}
      <CardHeader className="flex-row items-center justify-between border-b px-4 py-3">
        <CardTitle className="text-sm">Loop Progress</CardTitle>
        <div className="flex items-center gap-2">
          {active && (
            <LoaderIcon className="size-3.5 animate-spin text-blue-600 dark:text-blue-400" />
          )}
          <Badge
            className={cn("font-medium", displayStatusColorMap[displayStatus])}
            variant="outline"
          >
            {displayStatusLabels[displayStatus]}
          </Badge>
        </div>
      </CardHeader>

      {/* Timeline */}
      <CardContent className="min-h-0 flex-1 p-0">
        <ScrollArea className="h-full">
          <div className="space-y-4 p-4">
            {events.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <ClockIcon className="mb-2 size-8 text-muted-foreground/50" />
                <p className="text-muted-foreground text-sm">
                  Waiting for events...
                </p>
              </div>
            )}
            {events.map((event, idx) => (
              <EventItem event={event} key={`${event.type}-${idx}`} />
            ))}
            <div ref={scrollEndRef} />
          </div>
        </ScrollArea>
      </CardContent>

      {/* Footer */}
      <CardFooter className="flex-col gap-0 border-t px-4 py-0">
        <div className="flex w-full items-center justify-between py-2.5 text-muted-foreground text-xs">
          <div className="flex items-center gap-4">
            <span>
              Tokens: {formatTokenCount(tokensInput)} in /{" "}
              {formatTokenCount(tokensOutput)} out
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <ClockIcon className="size-3" />
            <span>{formatElapsedTime(elapsed)}</span>
          </div>
        </div>
      </CardFooter>
    </Card>
  );
}
