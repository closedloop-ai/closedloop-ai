"use client";

import { resolveFriendlyError } from "@repo/api/src/types/friendly-error";
import type { LoopEvent, LoopEventError } from "@repo/api/src/types/loop";
import { LoopEventType } from "@repo/api/src/types/loop";
import { useLoopEventsPaginated } from "@repo/app/loops/hooks/use-loops";
import {
  LoopEventTypeBadge,
  loopEventTypeLabels,
} from "@repo/app/shared/components/status-badge";
import {
  formatDateTimeOrFallback,
  formatRelativeTimeOrFallback,
} from "@repo/app/shared/lib/date-utils";
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
import { useMemo, useState } from "react";

type LoopAuditLogProps = {
  loopId: string;
};

// -- Detail renderers --

function getEventDetails(event: LoopEvent): string {
  switch (event.type) {
    case LoopEventType.Started:
      return `Loop ${event.loopId ?? event.correlationId ?? "unknown"} started`;
    case LoopEventType.Output:
      return event.chunk ?? "";
    case LoopEventType.Progress:
      return `${event.stage}${event.percent > 0 ? ` (${event.percent}%)` : ""}`;
    case LoopEventType.ToolCall:
      return `${event.tool} - ${event.status}`;
    case LoopEventType.ArtifactCreated:
      return `Created ${event.artifactType} (${event.artifactId})`;
    case LoopEventType.SupportBundleUploaded: {
      const fileCount =
        event.files && event.files.length > 0
          ? event.files.length
          : event.keys.length;
      return `Uploaded ${fileCount} support file(s)`;
    }
    case LoopEventType.Completed: {
      const tokens = event.tokensUsed ?? { input: 0, output: 0 };
      return `Tokens: ${tokens.input} in / ${tokens.output} out`;
    }
    case LoopEventType.Error:
      return getFriendlyErrorDetails(event);
    case LoopEventType.Cancelled:
      return event.reason ?? "Cancelled";
    default:
      return "";
  }
}

function getEventKey(event: LoopEvent): string {
  const details =
    event.type === LoopEventType.Error
      ? `${event.code}-${event.message.slice(0, 80)}`
      : getEventDetails(event).slice(0, 80);
  return `${event.type}-${event.timestamp ?? "untimed"}-${details}`;
}

function isExpandableEvent(event: LoopEvent): boolean {
  if (
    event.type === LoopEventType.Output &&
    event.chunk &&
    event.chunk.length > 100
  ) {
    return true;
  }
  if (event.type === LoopEventType.ToolCall && (event.input || event.output)) {
    return true;
  }
  if (event.type === LoopEventType.Completed && event.result) {
    return true;
  }
  if (event.type === LoopEventType.Cancelled && event.reason) {
    return true;
  }
  if (event.type === LoopEventType.SupportBundleUploaded) {
    return event.keys.length > 0;
  }
  if (event.type === LoopEventType.Error) {
    const e = event as LoopEventError;
    return (
      Object.keys(resolveLoopEventError(e).technicalDetails).length > 0 ||
      (typeof e.logTail === "string" && e.logTail.length > 0) ||
      e.tokenUsage !== undefined ||
      e.diagnosticsVersion !== undefined
    );
  }
  return false;
}

function getExpandedContent(event: LoopEvent): string | null {
  switch (event.type) {
    case LoopEventType.Output:
      return event.chunk ?? "";
    case LoopEventType.ToolCall: {
      const parts: string[] = [];
      if (event.input) {
        parts.push(`Input: ${JSON.stringify(event.input, null, 2)}`);
      }
      if (event.output) {
        parts.push(`Output: ${JSON.stringify(event.output, null, 2)}`);
      }
      return parts.join("\n\n");
    }
    case LoopEventType.Completed:
      return JSON.stringify(event.result, null, 2);
    case LoopEventType.Cancelled:
      return event.reason ?? null;
    case LoopEventType.SupportBundleUploaded:
      return JSON.stringify(
        event.files?.length ? event.files : event.keys.map((key) => ({ key })),
        null,
        2
      );
    case LoopEventType.Error: {
      const e = event as LoopEventError;
      const parts: string[] = [];
      const friendly = resolveLoopEventError(e);
      if (Object.keys(friendly.technicalDetails).length > 0) {
        parts.push(
          `Technical details:\n${JSON.stringify(friendly.technicalDetails, null, 2)}`
        );
      }
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
  return `${text.slice(0, maxLength)}...`;
}

function getFriendlyErrorDetails(event: LoopEventError): string {
  const friendly = resolveLoopEventError(event);
  return `${friendly.title}: ${friendly.description}`;
}

function resolveLoopEventError(event: LoopEventError) {
  return resolveFriendlyError({
    code: event.code,
    message: event.message,
    result: event.result ?? undefined,
    timestamp: event.timestamp,
  });
}

// -- Event Row --

function EventRow({ event }: { event: LoopEvent }) {
  const [isOpen, setIsOpen] = useState(false);
  const expandable = isExpandableEvent(event);
  const details = getEventDetails(event);
  // Computing the expanded content runs several JSON.stringify(…, null, 2)
  // passes, so defer it until the row is actually expanded.
  const expandedContent = useMemo(
    () => (expandable && isOpen ? getExpandedContent(event) : null),
    [expandable, isOpen, event]
  );

  return (
    <>
      <TableRow
        aria-expanded={expandable ? isOpen : undefined}
        className={cn(expandable && "cursor-pointer hover:bg-muted/50")}
        onClick={expandable ? () => setIsOpen((o) => !o) : undefined}
        onKeyDown={
          expandable
            ? (keyEvent) => {
                // Only toggle when the row itself is focused, not when the
                // event bubbles up from a focusable child.
                if (
                  keyEvent.target === keyEvent.currentTarget &&
                  (keyEvent.key === "Enter" || keyEvent.key === " ")
                ) {
                  keyEvent.preventDefault();
                  setIsOpen((o) => !o);
                }
              }
            : undefined
        }
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
      >
        <TableCell className="whitespace-nowrap">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-muted-foreground text-sm">
                  {event.timestamp
                    ? formatRelativeTimeOrFallback(event.timestamp)
                    : "—"}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {event.timestamp
                  ? formatDateTimeOrFallback(event.timestamp)
                  : "—"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </TableCell>
        <TableCell>
          <LoopEventTypeBadge eventType={event.type} />
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
              <SelectItem value={LoopEventType.Started}>Started</SelectItem>
              <SelectItem value={LoopEventType.Output}>Output</SelectItem>
              <SelectItem value={LoopEventType.Progress}>Progress</SelectItem>
              <SelectItem value={LoopEventType.ToolCall}>Tool Call</SelectItem>
              <SelectItem value={LoopEventType.ArtifactCreated}>
                Artifact Created
              </SelectItem>
              <SelectItem value={LoopEventType.Completed}>Completed</SelectItem>
              <SelectItem value={LoopEventType.Error}>Error</SelectItem>
              <SelectItem value={LoopEventType.Cancelled}>Cancelled</SelectItem>
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
              : `No ${loopEventTypeLabels[typeFilter as LoopEventType] ?? typeFilter} events found`}
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
              {events.map((event) => (
                <EventRow event={event} key={getEventKey(event)} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
