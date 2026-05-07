"use client";

import type {
  LoopEvent,
  LoopEventError,
  LoopEventType,
} from "@repo/api/src/types/loop";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { ChevronDownIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { useLoopEventsPaginated } from "@/hooks/queries/use-loops";
import { formatDateTime, formatRelativeTime } from "@/lib/date-utils";
import { getLoopErrorTitle } from "@/lib/loop-error-display";

type LoopAuditLogProps = {
  loopId: string;
};

// -- Event type badge styling --

const eventTypeBadgeStyles: Record<LoopEventType, string> = {
  started:
    "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800",
  output:
    "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700",
  progress:
    "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800",
  tool_call:
    "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800",
  artifact_created:
    "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
  completed:
    "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
  error:
    "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800",
  cancelled:
    "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800",
};

const eventTypeLabels: Record<LoopEventType, string> = {
  started: "Started",
  output: "Output",
  progress: "Progress",
  tool_call: "Tool Call",
  artifact_created: "Artifact Created",
  completed: "Completed",
  error: "Error",
  cancelled: "Cancelled",
};

// -- Detail renderers --

function getEventDetails(event: LoopEvent): string {
  switch (event.type) {
    case "started":
      return `Loop ${event.loopId} started`;
    case "output":
      return event.chunk ?? "";
    case "progress":
      return `${event.stage}${event.percent > 0 ? ` (${event.percent}%)` : ""}`;
    case "tool_call":
      return `${event.tool} - ${event.status}`;
    case "artifact_created":
      return `Created ${event.artifactType} (${event.artifactId})`;
    case "completed": {
      const tokens = event.tokensUsed ?? { input: 0, output: 0 };
      return `Tokens: ${tokens.input} in / ${tokens.output} out`;
    }
    case "error":
      return `${getLoopErrorTitle(event)}: ${event.message}`;
    case "cancelled":
      return event.reason ?? "Cancelled";
    default:
      return "";
  }
}

function isExpandableEvent(event: LoopEvent): boolean {
  if (event.type === "output" && event.chunk && event.chunk.length > 100) {
    return true;
  }
  if (event.type === "tool_call" && (event.input || event.output)) {
    return true;
  }
  if (event.type === "completed" && event.result) {
    return true;
  }
  if (event.type === "cancelled" && event.reason) {
    return true;
  }
  if (event.type === "error") {
    const e = event as LoopEventError;
    return (
      (typeof e.logTail === "string" && e.logTail.length > 0) ||
      e.tokenUsage !== undefined ||
      e.diagnosticsVersion !== undefined
    );
  }
  return false;
}

function getExpandedContent(event: LoopEvent): string | null {
  switch (event.type) {
    case "output":
      return event.chunk ?? "";
    case "tool_call": {
      const parts: string[] = [];
      if (event.input) {
        parts.push(`Input: ${JSON.stringify(event.input, null, 2)}`);
      }
      if (event.output) {
        parts.push(`Output: ${JSON.stringify(event.output, null, 2)}`);
      }
      return parts.join("\n\n");
    }
    case "completed":
      return JSON.stringify(event.result, null, 2);
    case "cancelled":
      return event.reason ?? null;
    case "error": {
      const e = event as LoopEventError;
      const parts: string[] = [];
      if (e.tokenUsage) {
        parts.push(
          `Tokens: ${e.tokenUsage.inputTokens} in / ${e.tokenUsage.outputTokens} out`
        );
      }
      if (e.diagnosticsVersion) {
        parts.push(`Diagnostics version: ${e.diagnosticsVersion}`);
      }
      if (e.logTail) {
        parts.push(`Log tail:\n${e.logTail}`);
      }
      return parts.length > 0 ? parts.join("\n\n") : null;
    }
    default:
      return null;
  }
}

function truncateDetails(text: string, maxLength = 100): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.substring(0, maxLength)}...`;
}

// -- Event Row --

function EventRow({ event }: { event: LoopEvent }) {
  const [isOpen, setIsOpen] = useState(false);
  const expandable = isExpandableEvent(event);
  const details = getEventDetails(event);
  const expandedContent = expandable ? getExpandedContent(event) : null;

  return (
    <>
      <TableRow
        className={cn(expandable && "cursor-pointer hover:bg-muted/50")}
        onClick={expandable ? () => setIsOpen((o) => !o) : undefined}
      >
        <TableCell className="whitespace-nowrap">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-muted-foreground text-sm">
                  {event.timestamp ? formatRelativeTime(event.timestamp) : "—"}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {event.timestamp ? formatDateTime(event.timestamp) : "—"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </TableCell>
        <TableCell>
          <Badge
            className={cn("font-medium", eventTypeBadgeStyles[event.type])}
            variant="outline"
          >
            {eventTypeLabels[event.type]}
          </Badge>
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-2">
            <span className="text-sm">{truncateDetails(details)}</span>
            {expandable && (
              <ChevronDownIcon
                className={cn(
                  "ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
                  isOpen && "rotate-180"
                )}
              />
            )}
          </div>
        </TableCell>
      </TableRow>
      {expandable && isOpen && expandedContent && (
        <TableRow>
          <TableCell className="p-0" colSpan={3}>
            <Collapsible onOpenChange={setIsOpen} open={isOpen}>
              <CollapsibleTrigger className="hidden" />
              <CollapsibleContent>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words bg-muted/50 p-4 text-xs">
                  {expandedContent}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// -- Main component --

export function LoopAuditLog({ loopId }: Readonly<LoopAuditLogProps>) {
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const filters = {
    ...(typeFilter === "all" ? {} : { type: typeFilter as LoopEventType }),
    limit: 200,
  };

  const {
    data: response,
    isLoading,
    error,
  } = useLoopEventsPaginated(loopId, filters);

  const events = response?.data ?? [];
  const total = response?.total ?? 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4 text-destructive">
        {error.message ?? "Failed to load events"}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">Event type:</span>
          <Select onValueChange={setTypeFilter} value={typeFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All events</SelectItem>
              <SelectItem value="started">Started</SelectItem>
              <SelectItem value="output">Output</SelectItem>
              <SelectItem value="progress">Progress</SelectItem>
              <SelectItem value="tool_call">Tool Call</SelectItem>
              <SelectItem value="artifact_created">Artifact Created</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="error">Error</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <span className="text-muted-foreground text-sm">
          {events.length} of {total} events
        </span>
      </div>

      {events.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
          <p className="text-muted-foreground text-sm">
            {typeFilter === "all"
              ? "No events recorded for this loop"
              : `No ${eventTypeLabels[typeFilter as LoopEventType] ?? typeFilter} events found`}
          </p>
        </div>
      ) : (
        <div className="max-h-[500px] overflow-auto rounded-md border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead className="w-[140px]">Timestamp</TableHead>
                <TableHead className="w-[160px]">Event Type</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event, idx) => (
                <EventRow
                  event={event}
                  key={`${event.type}-${event.timestamp}-${idx}`}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
