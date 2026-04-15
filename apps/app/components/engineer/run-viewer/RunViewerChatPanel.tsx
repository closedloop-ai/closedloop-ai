"use client";

import { cn } from "@repo/design-system/lib/utils";
import { Loader2, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ContentBlock } from "@/components/engineer/chat";
import { MessageContent } from "@/components/engineer/chat";
import { formatTime } from "@/lib/engineer/chat-utils";
import { readTerminalStream } from "@/lib/engineer/terminal-stream";

type RunViewerChatPanelProps = {
  selectedFilePath: string | null;
  selectedFileContent: string | undefined;
  runDir?: string;
  onClose?: () => void;
};

type ChatEntry = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  blocks?: ContentBlock[];
};

type ActiveStream = {
  textContent: string;
  blocks: ContentBlock[];
  error?: string;
};

export function RunViewerChatPanel({
  selectedFilePath,
  selectedFileContent,
  runDir,
  onClose,
}: Readonly<RunViewerChatPanelProps>) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [activeStream, setActiveStream] = useState<ActiveStream | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [input, setInput] = useState("");
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = "40px";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, []);

  // Fetch chat history from server
  const reloadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/gateway/run-viewer-chat");
      if (res.ok) {
        const data = await res.json();
        if (data.messages) {
          setEntries(
            data.messages.map((msg: ChatEntry) => ({
              id: msg.id,
              role: msg.role,
              content: msg.content,
              timestamp: msg.timestamp,
              blocks: msg.blocks,
            }))
          );
        }
      }
    } catch {
      // Ignore
    }
  }, []);

  // Load history on mount
  useEffect(() => {
    reloadHistory().finally(() => setIsLoadingHistory(false));
  }, [reloadHistory]);

  // Scroll to bottom
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  // Focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const sendMessage = useCallback(
    async (messageText: string) => {
      if (!messageText.trim() || isStreaming) {
        return;
      }

      const trimmed = messageText.trim();

      // Add user entry
      const userEntry: ChatEntry = {
        id: `user-${Date.now()}`,
        role: "user",
        content: trimmed,
        timestamp: new Date().toISOString(),
      };
      setEntries((prev) => [...prev, userEntry]);
      setIsStreaming(true);
      setActiveStream({ textContent: "", blocks: [] });

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      // Build file context if a file is selected
      const fileContext =
        selectedFilePath && selectedFileContent
          ? {
              path: selectedFilePath,
              contentPreview: selectedFileContent.slice(0, 4000),
            }
          : undefined;

      try {
        const response = await fetch("/api/gateway/run-viewer-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed, fileContext, runDir }),
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

        await readTerminalStream(reader, {
          onText: (accumulated: string) => {
            setActiveStream((prev) => updateStreamText(prev, accumulated));
          },
          onToolUse: (tool) => {
            setActiveStream((prev) => appendToolUseBlock(prev, tool));
          },
          onToolResult: (result) => {
            setActiveStream((prev) => resolveToolResult(prev, result));
          },
          onThinking: (content) => {
            setActiveStream((prev) => appendThinkingBlock(prev, content));
          },
          onClear: () => {
            setEntries([]);
            setActiveStream(null);
            setIsStreaming(false);
          },
          onError: (error) => {
            setActiveStream((prev) => updateStreamError(prev, error));
          },
          onComplete: () => {},
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // User cancelled
        } else {
          console.error("Run viewer chat error:", err);
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
        // Reload history from server so the persisted assistant message appears in entries
        await reloadHistory();
        setIsStreaming(false);
        setActiveStream(null);
        abortControllerRef.current = null;
      }
    },
    [isStreaming, selectedFilePath, selectedFileContent, runDir, reloadHistory]
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

  const stopStreaming = () => {
    abortControllerRef.current?.abort();
  };

  const handleClearChat = useCallback(async () => {
    try {
      await fetch("/api/gateway/run-viewer-chat", { method: "DELETE" });
      setEntries([]);
    } catch {
      // Best effort
    }
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Chat header */}
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-muted-foreground text-xs">
            Chat
          </span>
          {entries.length > 0 && (
            <span className="text-[10px] text-muted-foreground/50">
              {entries.length} msg{entries.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {entries.length > 0 && !isStreaming && (
            <button
              className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted/50 hover:text-destructive"
              onClick={handleClearChat}
              title="Clear chat"
            >
              <Trash2 className="size-3" />
            </button>
          )}
          {onClose && (
            <button
              className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              onClick={onClose}
              title="Close chat"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Chat messages */}
      <div className="chat-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3 font-mono text-sm">
        {isLoadingHistory && (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}

        {!isLoadingHistory && entries.length === 0 && !isStreaming && (
          <div className="flex h-full flex-col items-start justify-center space-y-1 text-muted-foreground/70 text-xs">
            <div>Ask about the run files</div>
            <div className="animate-pulse">_</div>
          </div>
        )}

        {!isLoadingHistory && (entries.length > 0 || isStreaming) && (
          <div className="space-y-3">
            {entries.map((entry) => (
              <ChatEntryRow entry={entry} key={entry.id} />
            ))}

            {isStreaming && activeStream?.textContent && (
              <div className="space-y-1 pl-3">
                <span className="rounded bg-blue-500/15 px-1.5 py-0.5 font-mono text-[10px] text-blue-600 uppercase dark:text-blue-400">
                  claude
                </span>
                <div className="border-green-500/30 border-l-2 pl-2 text-foreground text-sm leading-relaxed">
                  <MessageContent
                    blocks={activeStream.blocks}
                    content={activeStream.textContent}
                    isStreaming
                  />
                </div>
              </div>
            )}

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
                  <span className="text-xs">claude is thinking...</span>
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

      {/* Input */}
      <div className="shrink-0 border-t">
        <div className="relative flex items-end gap-2 p-3 pt-2">
          <span className="shrink-0 pb-2.5 font-bold font-mono text-muted-foreground text-sm">
            &gt;
          </span>
          <div className="relative flex-1">
            <textarea
              className={cn(
                "w-full resize-none bg-transparent text-foreground text-sm placeholder:text-muted-foreground/50",
                "py-2 pr-8 font-mono leading-relaxed",
                "focus:outline-none focus:ring-0",
                "disabled:cursor-not-allowed disabled:opacity-50"
              )}
              disabled={isStreaming}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isStreaming ? "Waiting..." : "Ask about this run..."}
              ref={inputRef}
              rows={1}
              style={{
                minHeight: "40px",
                maxHeight: "30vh",
                overflow: "hidden",
              }}
              value={input}
            />
            {isStreaming ? (
              <button
                className={cn(
                  "absolute right-0 bottom-1.5 flex size-6 items-center justify-center rounded-md",
                  "cursor-pointer transition-all duration-200",
                  "bg-foreground/[0.08] text-foreground/50 hover:bg-foreground/15 hover:text-foreground"
                )}
                onClick={stopStreaming}
                title="Stop"
              >
                <Square className="size-2 fill-current" />
              </button>
            ) : (
              <button
                className={cn(
                  "absolute right-0 bottom-1.5 flex size-6 items-center justify-center rounded-md",
                  "cursor-pointer transition-all duration-200",
                  input.trim()
                    ? "bg-green-500 text-black shadow-green-500/20 shadow-lg hover:bg-green-400"
                    : "cursor-not-allowed bg-muted text-muted-foreground/50"
                )}
                disabled={!input.trim()}
                onClick={handleSend}
                title="Send"
              >
                <span className="font-bold text-[10px]">&#9654;</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function updateStreamText(
  prev: ActiveStream | null,
  accumulated: string
): ActiveStream | null {
  if (!prev) {
    return null;
  }
  return { ...prev, textContent: accumulated };
}

function appendToolUseBlock(
  prev: ActiveStream | null,
  tool: { id: string; name: string; input: unknown }
): ActiveStream | null {
  if (!prev) {
    return null;
  }
  return {
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
  };
}

function resolveToolResult(
  prev: ActiveStream | null,
  result: { id: string; content: string; is_error: boolean }
): ActiveStream | null {
  if (!prev) {
    return null;
  }
  return {
    ...prev,
    blocks: prev.blocks.map((block) =>
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

function appendThinkingBlock(
  prev: ActiveStream | null,
  content: string
): ActiveStream | null {
  if (!prev) {
    return null;
  }
  return {
    ...prev,
    blocks: [
      ...prev.blocks,
      {
        type: "thinking" as const,
        id: `thinking-${Date.now()}`,
        thinking: content,
      },
    ],
  };
}

function updateStreamError(
  prev: ActiveStream | null,
  error: string
): ActiveStream | null {
  if (!prev) {
    return null;
  }
  return { ...prev, error };
}

function ChatEntryRow({ entry }: Readonly<{ entry: ChatEntry }>) {
  if (entry.role === "user") {
    return (
      <div className="flex items-start gap-1.5">
        <span className="shrink-0 font-bold text-muted-foreground">&gt;</span>
        <span className="break-all text-foreground">{entry.content}</span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/50">
          {formatTime(entry.timestamp)}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-1 pl-3">
      <div className="flex items-center gap-2">
        <span className="rounded bg-blue-500/15 px-1.5 py-0.5 font-mono text-[10px] text-blue-600 uppercase dark:text-blue-400">
          claude
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
