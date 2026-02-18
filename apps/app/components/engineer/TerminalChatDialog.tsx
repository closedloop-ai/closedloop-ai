"use client";

import { Dialog, DialogTitle } from "@repo/design-system/components/ui/dialog";
import { cn } from "@repo/design-system/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Square } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ContentBlock } from "@/components/engineer/chat";
import { MessageContent } from "@/components/engineer/chat";
import { ExpandableDialogContent } from "@/components/engineer/ExpandableDialogContent";
import { formatTime } from "@/lib/engineer/chat-utils";
import { queryKeys } from "@/lib/engineer/queries/keys";
import type {
  TerminalMessage,
  TerminalMessageMode,
} from "@/lib/engineer/queries/terminal";
import { terminalChatHistoryOptions } from "@/lib/engineer/queries/terminal";
import { readTerminalStream } from "@/lib/engineer/terminal-stream";

type TerminalChatDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// An entry in the chat display
type TerminalEntry = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  mode: TerminalMessageMode;
  blocks?: ContentBlock[];
};

// Active streaming state
type ActiveStream = {
  mode: TerminalMessageMode;
  textContent: string;
  blocks: ContentBlock[];
  error?: string;
};

/**
 * Detect the mode based on what the user is typing.
 * Claude is the default; @codex routes to Codex.
 */
function detectInputMode(input: string): TerminalMessageMode {
  const trimmed = input.trimStart();
  if (trimmed.startsWith("@codex ") || trimmed === "@codex") {
    return "codex";
  }
  return "claude";
}

/**
 * Convert history messages to display entries, filtering out legacy shell entries.
 */
function historyToEntries(messages: TerminalMessage[]): TerminalEntry[] {
  return messages
    .filter((msg) => msg.role !== "shell")
    .map((msg) => ({
      id: msg.id,
      role: msg.role as "user" | "assistant",
      content: msg.content,
      timestamp: msg.timestamp,
      mode: msg.mode === "shell" ? "claude" : msg.mode || "claude",
      blocks: msg.blocks,
    }));
}

/**
 * TerminalChatDialog - A chat interface with Claude (default) and @codex routing.
 */
export function TerminalChatDialog({
  open,
  onOpenChange,
}: Readonly<TerminalChatDialogProps>) {
  const [input, setInput] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const [activeStream, setActiveStream] = useState<ActiveStream | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();

  const inputMode = detectInputMode(input);

  // Auto-resize textarea when input changes
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = "40px";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, []);

  // Load chat history
  const { data: history, isLoading: isLoadingHistory } = useQuery({
    ...terminalChatHistoryOptions(),
    enabled: open,
  });

  // Sync entries from history when it loads/updates
  useEffect(() => {
    if (history?.messages) {
      setEntries(historyToEntries(history.messages));
    }
  }, [history]);

  // Auto-scroll
  const scrollToBottom = useCallback((instant?: boolean) => {
    messagesEndRef.current?.scrollIntoView({
      behavior: instant ? "instant" : "smooth",
    });
  }, []);

  const initialScrollDone = useRef(false);
  useEffect(() => {
    if (!initialScrollDone.current && entries.length > 0) {
      initialScrollDone.current = true;
      requestAnimationFrame(() => scrollToBottom(true));
    } else {
      scrollToBottom();
    }
  }, [entries, scrollToBottom]);

  // Focus input when dialog opens
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
    if (!open) {
      initialScrollDone.current = false;
    }
  }, [open]);

  // CMD+K to clear
  useEffect(() => {
    if (!open) {
      return;
    }
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "k") {
        e.preventDefault();
        handleClear();
      }
    };
    globalThis.addEventListener("keydown", handler);
    return () => globalThis.removeEventListener("keydown", handler);
  });

  // Send a message
  const sendMessage = useCallback(
    async (messageText: string) => {
      if (!messageText.trim() || isStreaming) {
        return;
      }

      const trimmed = messageText.trim();
      const mode = detectInputMode(trimmed);

      // Add user entry immediately
      const userEntry: TerminalEntry = {
        id: `user-${Date.now()}`,
        role: "user",
        content: trimmed,
        timestamp: new Date().toISOString(),
        mode,
      };
      setEntries((prev) => [...prev, userEntry]);
      setIsStreaming(true);
      setActiveStream({ mode, textContent: "", blocks: [] });

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        const response = await fetch("/api/engineer/terminal-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed }),
          signal: abortController.signal,
        });

        if (!response.ok) {
          const err = await response
            .json()
            .catch(() => ({ error: "Request failed" }));
          setActiveStream((prev) =>
            prev ? { ...prev, error: err.error || "Request failed" } : null
          );
          setIsStreaming(false);
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No response body");
        }

        await readTerminalStream(
          reader,
          buildStreamHandlers(
            setActiveStream,
            setEntries,
            setIsStreaming,
            queryClient
          )
        );
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // User cancelled
        } else {
          console.error("Terminal stream error:", err);
          setActiveStream((prev) =>
            prev
              ? {
                  ...prev,
                  error:
                    err instanceof Error ? err.message : "Connection failed",
                }
              : null
          );
        }
      } finally {
        setIsStreaming(false);
        setActiveStream(null);
        abortControllerRef.current = null;
        await queryClient.invalidateQueries({
          queryKey: queryKeys.terminalChatHistory(),
        });
      }
    },
    [isStreaming, queryClient]
  );

  const handleSend = () => {
    if (input.trim() && !isStreaming) {
      const msg = input;
      setInput("");
      sendMessage(msg);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleClear = async () => {
    setEntries([]);
    setActiveStream(null);
    try {
      await fetch("/api/engineer/terminal-chat", { method: "DELETE" });
      queryClient.invalidateQueries({
        queryKey: queryKeys.terminalChatHistory(),
      });
    } catch (err) {
      console.error("Failed to clear:", err);
    }
  };

  const stopStreaming = () => {
    abortControllerRef.current?.abort();
  };

  // Insert prefix into input when clicking hint buttons
  const insertPrefix = (prefix: string) => {
    setInput(`${prefix} `);
    inputRef.current?.focus();
  };

  // Prompt indicator
  const promptIndicator = (() => {
    if (isStreaming && activeStream) {
      if (activeStream.mode === "codex") {
        return { text: "@codex", color: "text-orange-400" };
      }
      return { text: ">", color: "text-muted-foreground" };
    }
    if (inputMode === "codex") {
      return { text: "@codex", color: "text-orange-400" };
    }
    return { text: ">", color: "text-muted-foreground" };
  })();

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <ExpandableDialogContent
        className={cn(
          "h-[80vh] max-h-[800px] w-[95vw] max-w-2xl md:max-w-3xl lg:max-w-4xl",
          "terminal-glass flex flex-col gap-0 overflow-hidden p-0",
          "bg-[#faf9f7]/[0.92] dark:bg-[#0f0f12]/[0.92]",
          "border-black/[0.06] text-foreground dark:border-white/[0.08]"
        )}
        isExpanded={isExpanded}
        overlayClassName="bg-black/20 dark:bg-black/40 backdrop-blur-[2px]"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">cl.dev chat</DialogTitle>

        <div className="flex h-full flex-col">
          {/* Terminal titlebar */}
          <div className="flex shrink-0 items-center gap-1.5 border-black/[0.06] border-b bg-black/[0.02] px-3 py-2.5 dark:border-white/[0.06] dark:bg-white/[0.03]">
            <button
              aria-label="Close chat"
              className="size-3 cursor-pointer rounded-full bg-[#ff5f57] shadow-[0_0_4px_rgba(255,95,87,0.3)] transition-colors hover:bg-[#ff3b30]"
              onClick={() => onOpenChange(false)}
              title="Close"
            />
            <button
              aria-label={isExpanded ? "Exit fullscreen" : "Fullscreen"}
              className="size-3 cursor-pointer rounded-full bg-[#febc2e] shadow-[0_0_4px_rgba(254,188,46,0.3)] transition-colors hover:bg-[#f0a000]"
              onClick={() => setIsExpanded((v) => !v)}
              title={isExpanded ? "Windowed" : "Fullscreen"}
            />
            <span
              className="terminal-active-dot size-3 rounded-full bg-[#28c840]"
              title="Active"
            />
            <span className="flex-1 select-none text-center font-mono text-[11px] text-muted-foreground tracking-wide">
              ~/cl.dev
            </span>
          </div>

          {/* Chat output area */}
          <div className="chat-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-4 font-mono text-sm">
            {isLoadingHistory && (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {/* Welcome screen */}
            {!isLoadingHistory && entries.length === 0 && !isStreaming && (
              <div className="flex h-full flex-col items-start justify-center">
                <div className="space-y-0.5 text-muted-foreground">
                  <div>
                    <span className="text-muted-foreground">&gt;</span> Welcome
                    to closedloop.dev
                  </div>
                  <div className="pl-4 text-muted-foreground/70">
                    chat with claude — your AI dev assistant
                  </div>
                  <div className="pl-4 text-muted-foreground/70">
                    use <span className="text-orange-400">@codex</span> to bring
                    in codex
                  </div>
                  <div className="pl-4 text-muted-foreground/70">
                    <span className="animate-pulse">_</span>
                  </div>
                </div>
              </div>
            )}

            {/* Entries */}
            {!isLoadingHistory && (entries.length > 0 || isStreaming) && (
              <div className="space-y-3">
                {entries.map((entry) => (
                  <TerminalEntryRow entry={entry} key={entry.id} />
                ))}

                {/* Active stream output */}
                {isStreaming && activeStream && (
                  <ActiveStreamOutput stream={activeStream} />
                )}

                {/* Loading indicator */}
                {isStreaming &&
                  activeStream &&
                  !activeStream.textContent &&
                  !activeStream.error && (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <div className="flex gap-1">
                        <span className="size-1.5 animate-bounce rounded-full bg-green-400/60 [animation-delay:0ms]" />
                        <span className="size-1.5 animate-bounce rounded-full bg-green-400/60 [animation-delay:150ms]" />
                        <span className="size-1.5 animate-bounce rounded-full bg-green-400/60 [animation-delay:300ms]" />
                      </div>
                      <span className="text-xs">
                        <StreamingLabel mode={activeStream.mode} />
                      </span>
                    </div>
                  )}

                {activeStream?.error && (
                  <div className="text-red-400 text-xs">
                    Error: {activeStream.error}
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* Input area */}
          <div className="shrink-0 border-black/[0.06] border-t bg-black/[0.02] dark:border-white/[0.06] dark:bg-white/[0.02]">
            <div className="relative flex items-end gap-3 p-4 pt-3">
              <span
                className={cn(
                  "shrink-0 pb-2.5 font-bold font-mono text-sm transition-colors",
                  promptIndicator.color
                )}
              >
                {promptIndicator.text}
              </span>
              <div className="relative flex-1">
                <textarea
                  className={cn(
                    "w-full resize-none bg-transparent text-foreground text-sm placeholder:text-muted-foreground/50",
                    "py-2 pr-10 font-mono leading-relaxed",
                    "focus:outline-none focus:ring-0",
                    "disabled:cursor-not-allowed disabled:opacity-50"
                  )}
                  disabled={isStreaming}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    isStreaming
                      ? "Waiting for response..."
                      : "Ask Claude anything, or @codex..."
                  }
                  ref={inputRef}
                  rows={1}
                  style={{
                    minHeight: "40px",
                    maxHeight: "50vh",
                    overflow: "hidden",
                  }}
                  value={input}
                />
                {isStreaming ? (
                  <button
                    className={cn(
                      "absolute right-0 bottom-1.5 flex size-7 items-center justify-center rounded-lg",
                      "cursor-pointer transition-all duration-200",
                      "bg-foreground/[0.08] text-foreground/50 hover:bg-foreground/15 hover:text-foreground"
                    )}
                    onClick={stopStreaming}
                    title="Stop"
                  >
                    <Square className="size-2.5 fill-current" />
                  </button>
                ) : (
                  <button
                    className={cn(
                      "absolute right-0 bottom-1.5 flex size-7 items-center justify-center rounded-lg",
                      "cursor-pointer transition-all duration-200",
                      input.trim()
                        ? "bg-green-500 text-black shadow-green-500/20 shadow-lg hover:bg-green-400"
                        : "cursor-not-allowed bg-muted text-muted-foreground/50"
                    )}
                    disabled={!input.trim()}
                    onClick={handleSend}
                    title="Send"
                  >
                    <span className="font-bold text-xs">&#9654;</span>
                  </button>
                )}
              </div>
            </div>

            {/* Hint bar */}
            <div className="flex items-center gap-4 px-4 pb-3">
              <button
                className="cursor-pointer font-mono text-[10px] text-orange-400/60 transition-colors hover:text-orange-400"
                onClick={() => insertPrefix("@codex")}
              >
                @codex <span className="text-muted-foreground/50">Codex</span>
              </button>
              <span className="font-mono text-[10px] text-muted-foreground/40">
                {"\u2318"}K clear
              </span>
              <span className="flex-1" />
              <span className="font-mono text-[10px] text-muted-foreground/40">
                Shift+Enter new line
              </span>
            </div>
          </div>
        </div>
      </ExpandableDialogContent>
    </Dialog>
  );
}

/**
 * Render a single chat entry (from history)
 */
const TerminalEntryRow = memo(function TerminalEntryRow({
  entry,
}: Readonly<{ entry: TerminalEntry }>) {
  if (entry.role === "user") {
    return <UserCommandLine entry={entry} />;
  }

  return <AIResponseBlock entry={entry} />;
});

/**
 * User message display — shows `> message` or `@codex message`
 */
function UserCommandLine({ entry }: Readonly<{ entry: TerminalEntry }>) {
  const prefix = (() => {
    if (entry.mode === "codex") {
      return { text: "@codex", color: "text-orange-400" };
    }
    return { text: ">", color: "text-muted-foreground" };
  })();

  // Strip the @codex prefix from display content
  let displayContent = entry.content;
  if (entry.mode === "codex" && displayContent.startsWith("@codex ")) {
    displayContent = displayContent.slice(7);
  }

  return (
    <div className="flex items-start gap-2">
      <span className={cn("shrink-0 font-bold", prefix.color)}>
        {prefix.text}
      </span>
      <span className="break-all text-foreground">{displayContent}</span>
      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/50">
        {formatTime(entry.timestamp)}
      </span>
    </div>
  );
}

/**
 * AI response block (Claude or Codex) rendered with MessageContent
 */
function AIResponseBlock({ entry }: Readonly<{ entry: TerminalEntry }>) {
  const badgeColor =
    entry.mode === "claude"
      ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
      : "bg-orange-500/15 text-orange-600 dark:text-orange-400";
  const badgeLabel = entry.mode === "claude" ? "claude" : "codex";

  return (
    <div className="space-y-1 pl-4">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[10px] uppercase",
            badgeColor
          )}
        >
          {badgeLabel}
        </span>
        <span className="text-[10px] text-muted-foreground/50">
          {formatTime(entry.timestamp)}
        </span>
      </div>
      <div className="text-foreground text-sm leading-relaxed">
        <MessageContent blocks={entry.blocks} content={entry.content} />
      </div>
    </div>
  );
}

/**
 * Active stream output — rendered while streaming is in progress
 */
function ActiveStreamOutput({ stream }: Readonly<{ stream: ActiveStream }>) {
  if (!stream.textContent && stream.blocks.length === 0) {
    return null;
  }

  const badgeColor =
    stream.mode === "claude"
      ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
      : "bg-orange-500/15 text-orange-600 dark:text-orange-400";
  const badgeLabel = stream.mode === "claude" ? "claude" : "codex";

  return (
    <div className="space-y-1 pl-4">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[10px] uppercase",
            badgeColor
          )}
        >
          {badgeLabel}
        </span>
      </div>
      <div className="border-green-500/30 border-l-2 pl-3 text-foreground text-sm leading-relaxed">
        <MessageContent
          blocks={stream.blocks}
          content={stream.textContent}
          isStreaming
        />
      </div>
    </div>
  );
}

/**
 * Loading label for active streams
 */
function StreamingLabel({ mode }: Readonly<{ mode: TerminalMessageMode }>) {
  if (mode === "codex") {
    return <>codex is thinking...</>;
  }
  return <>claude is thinking...</>;
}

/**
 * Build stream event handlers — extracted to reduce nesting depth in sendMessage
 */
function buildStreamHandlers(
  setActiveStream: React.Dispatch<React.SetStateAction<ActiveStream | null>>,
  setEntries: React.Dispatch<React.SetStateAction<TerminalEntry[]>>,
  setIsStreaming: React.Dispatch<React.SetStateAction<boolean>>,
  queryClient: ReturnType<typeof useQueryClient>
) {
  return {
    onText: (accumulated: string) => {
      setActiveStream((prev) =>
        prev ? { ...prev, textContent: accumulated } : null
      );
    },
    onToolUse: (tool: { name: string; input: unknown; id: string }) => {
      setActiveStream((prev) =>
        prev
          ? {
              ...prev,
              blocks: [
                ...prev.blocks,
                {
                  type: "tool_use" as const,
                  id: tool.id,
                  name: tool.name,
                  input: tool.input,
                },
              ],
            }
          : null
      );
    },
    onToolResult: (result: {
      id: string;
      content: string;
      is_error: boolean;
    }) => {
      setActiveStream((prev) => (prev ? applyToolResult(prev, result) : null));
    },
    onThinking: (content: string) => {
      setActiveStream((prev) =>
        prev
          ? {
              ...prev,
              blocks: [
                ...prev.blocks,
                {
                  type: "thinking" as const,
                  id: `thinking-${Date.now()}`,
                  thinking: content,
                },
              ],
            }
          : null
      );
    },
    onClear: () => {
      setEntries([]);
      setActiveStream(null);
      setIsStreaming(false);
      fetch("/api/engineer/terminal-chat", { method: "DELETE" }).catch(
        () => {}
      );
      queryClient.invalidateQueries({
        queryKey: queryKeys.terminalChatHistory(),
      });
    },
    onError: (error: string) => {
      setActiveStream((prev) => (prev ? { ...prev, error } : null));
    },
    onComplete: () => {},
    onPid: () => {},
    onStatus: () => {},
  };
}

function applyToolResult(
  stream: ActiveStream,
  result: { id: string; content: string; is_error: boolean }
): ActiveStream {
  return {
    ...stream,
    blocks: stream.blocks.map((block) =>
      block.id === result.id
        ? {
            ...block,
            type: "tool_result" as const,
            content: result.content,
            is_error: result.is_error,
          }
        : block
    ),
  };
}
