"use client";

import type {
  ConversationEntry,
  ExecutionTrace,
  ToolCall,
} from "@repo/api/src/types/execution-log";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { ScrollArea } from "@repo/design-system/components/ui/scroll-area";
import { cn } from "@repo/design-system/lib/utils";
import { BotIcon, ChevronDownIcon, TerminalIcon, UserIcon } from "lucide-react";
import { useEffect, useState } from "react";

type ExecutionLogDialogProps = {
  trace: ExecutionTrace | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSessionId?: string;
};

/**
 * Formats milliseconds into HH:MM:SS duration
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }
  if (minutes > 0) {
    return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  }
  return `${seconds}s`;
}

/**
 * Formats ISO timestamp to HH:MM:SS local time
 */
function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * Formats tool input for display based on tool name
 */
function formatToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read":
      return `File: ${input.file_path || "unknown"}`;
    case "Bash":
      return `Command: ${input.command || "unknown"}`;
    case "Edit": {
      const filePath = input.file_path || "unknown";
      const oldStr =
        typeof input.old_string === "string"
          ? input.old_string.substring(0, 50)
          : "";
      const newStr =
        typeof input.new_string === "string"
          ? input.new_string.substring(0, 50)
          : "";
      return `File: ${filePath}\nOld: ${oldStr}${oldStr.length >= 50 ? "..." : ""}\nNew: ${newStr}${newStr.length >= 50 ? "..." : ""}`;
    }
    default:
      return JSON.stringify(input, null, 2);
  }
}

/**
 * Tool result display component with expansion for long results
 */
function ToolResultDisplay({ result }: { result: string | null }) {
  const [expanded, setExpanded] = useState(false);

  if (!result) {
    return <div className="text-muted-foreground text-sm">(No result)</div>;
  }

  const lines = result.split("\n");
  const previewLines = 10;
  const hasMore = lines.length > previewLines;

  const displayLines = expanded ? lines : lines.slice(0, previewLines);

  return (
    <div className="space-y-2">
      <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">
        {displayLines.join("\n")}
      </pre>
      {hasMore && (
        <Button
          className="text-xs"
          onClick={() => setExpanded(!expanded)}
          size="sm"
          variant="ghost"
        >
          {expanded
            ? "Show less"
            : `Show ${lines.length - previewLines} more lines`}
        </Button>
      )}
    </div>
  );
}

/**
 * Tool call display component with collapsible details
 */
function ToolCallDisplay({ toolCall }: { toolCall: ToolCall }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Collapsible onOpenChange={setIsOpen} open={isOpen}>
      <CollapsibleTrigger asChild>
        <button
          aria-label={`Toggle ${toolCall.name} tool call details`}
          className="flex w-full items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50"
          type="button"
        >
          <TerminalIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">{toolCall.name}</span>
          {toolCall.truncated && (
            <Badge className="text-xs" variant="outline">
              Truncated
            </Badge>
          )}
          <ChevronDownIcon
            className={cn(
              "ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
              isOpen && "rotate-180"
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-3 border-l-2 pl-4">
        <div>
          <div className="mb-1 font-medium text-muted-foreground text-xs">
            Input
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 text-xs">
            {formatToolInput(toolCall.name, toolCall.input)}
          </pre>
        </div>
        <div>
          <div className="mb-1 font-medium text-muted-foreground text-xs">
            Result {toolCall.truncated && "(Result truncated)"}
          </div>
          <div className="rounded-md bg-muted/50 p-2">
            <ToolResultDisplay result={toolCall.result} />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Single conversation entry display (user or assistant message)
 */
function ConversationEntryDisplay({ entry }: { entry: ConversationEntry }) {
  const isUser = entry.role === "user";

  return (
    <div className="space-y-2">
      <div className={cn("rounded-lg p-3", isUser ? "bg-muted/50" : "border")}>
        <div className="mb-2 flex items-center gap-2">
          {isUser ? (
            <UserIcon className="size-4 text-muted-foreground" />
          ) : (
            <BotIcon className="size-4 text-muted-foreground" />
          )}
          <span className="font-medium text-xs">
            {isUser ? "User" : "Assistant"}
          </span>
          <span className="ml-auto text-muted-foreground text-xs">
            {formatTime(entry.timestamp)}
          </span>
        </div>
        <div className="whitespace-pre-wrap text-sm">{entry.content}</div>
      </div>

      {entry.toolCalls && entry.toolCalls.length > 0 && (
        <div className="space-y-2 pl-4">
          {entry.toolCalls.map((toolCall, idx) => (
            <ToolCallDisplay
              key={`${entry.timestamp}-tool-${idx}`}
              toolCall={toolCall}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Main execution log dialog component
 */
export function ExecutionLogDialog({
  trace,
  open,
  onOpenChange,
  initialSessionId,
}: Readonly<ExecutionLogDialogProps>) {
  const firstSessionId = trace?.sessions[0]?.sessionId;
  const [selectedSessionId, setSelectedSessionId] = useState<
    string | undefined
  >(initialSessionId || firstSessionId);

  // Sync selected session when initialSessionId changes (e.g., user clicks a different session)
  useEffect(() => {
    const targetId = initialSessionId || firstSessionId;
    if (targetId) {
      setSelectedSessionId(targetId);
    }
  }, [initialSessionId, firstSessionId]);

  const selectedSession = trace?.sessions.find(
    (s) => s.sessionId === selectedSessionId
  );

  if (!trace) {
    return (
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent className="h-[80vh] w-[calc(100vw-2rem)] max-w-5xl">
          <DialogHeader>
            <DialogTitle>Execution Log</DialogTitle>
          </DialogHeader>
          <div className="flex h-full items-center justify-center text-muted-foreground">
            No execution trace available
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex h-[80vh] w-[calc(100vw-2rem)] max-w-5xl flex-col p-0">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle>Execution Log</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* Left sidebar - Session navigator */}
          <ScrollArea className="w-56 border-r">
            <div className="space-y-2 p-4">
              {trace.sessions.map((session) => {
                const isActive = session.sessionId === selectedSessionId;
                return (
                  <button
                    aria-current={isActive ? "true" : undefined}
                    aria-label={`View ${session.agentLabel} session`}
                    className={cn(
                      "w-full rounded-md px-3 py-2 text-left text-sm transition-colors",
                      isActive ? "bg-muted font-medium" : "hover:bg-muted/50"
                    )}
                    key={session.sessionId}
                    onClick={() => setSelectedSessionId(session.sessionId)}
                    type="button"
                  >
                    <div className="mb-1 truncate font-medium">
                      {session.agentLabel}
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground text-xs">
                      <Badge className="text-xs" variant="outline">
                        {session.stats.messageCount}
                      </Badge>
                      {session.stats.duration !== null && (
                        <span>{formatDuration(session.stats.duration)}</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </ScrollArea>

          {/* Main content - Conversation viewer */}
          <ScrollArea className="flex-1">
            <div className="space-y-4 p-6">
              {selectedSession ? (
                <>
                  <div className="border-b pb-4">
                    <h3 className="mb-1 font-semibold text-lg">
                      {selectedSession.agentLabel}
                    </h3>
                    <div className="flex items-center gap-4 text-muted-foreground text-sm">
                      <span>{selectedSession.stats.messageCount} messages</span>
                      <span>
                        {selectedSession.stats.toolCallCount} tool calls
                      </span>
                      {selectedSession.stats.duration !== null && (
                        <span>
                          {formatDuration(selectedSession.stats.duration)}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="space-y-4">
                    {selectedSession.entries.map((entry, idx) => (
                      <ConversationEntryDisplay
                        entry={entry}
                        key={`${entry.timestamp}-${idx}`}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  Select a session to view conversation
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
