"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatMessage,
  ContentBlock,
} from "@/components/engineer/chat/types";
import type { LearningUsed } from "@/lib/engineer/chat-utils";
import { parseLearningsUsed, readChatStream } from "@/lib/engineer/chat-utils";

const MAX_RECONNECT_ATTEMPTS = 10;

export type UseChatStreamCallbacks = {
  /** Called when streaming completes. Receives the accumulated assistant text. */
  onComplete?: (accumulatedText: string) => void | Promise<void>;
  onPid?: (pid: number) => void;
  onLearnings?: () => void;
  onLearningsUsed?: (learnings: LearningUsed[]) => void;
  /** Called for every raw parsed JSON event before dispatch. Exposes fields
   *  like `effectiveDir` that aren't part of the typed StreamEvent. */
  onEvent?: (event: Record<string, unknown>) => void;
};

type UseChatStreamReturn = {
  streamingContent: string;
  streamingBlocks: ContentBlock[];
  isStreaming: boolean;
  error: string | null;
  pendingUserMessage: ChatMessage | null;
  setPendingUserMessage: (msg: ChatMessage | null) => void;
  sendMessage: (
    url: string,
    body: Record<string, unknown>,
    callbacks?: UseChatStreamCallbacks
  ) => Promise<void>;
  stopStreaming: () => void;
  /** Stable timestamp captured once when streaming begins */
  streamStartedAt: string;
  /** Context window usage percentage (0-100), updated after each turn */
  contextPercent: number | null;
};

/**
 * Shared hook encapsulating the streaming chat pattern used by
 * TicketChatDialog, CodexReviewDialog, and SymphonyChat.
 *
 * Manages streaming state, AbortController, readChatStream calls,
 * event handlers, and finally cleanup.
 */
export function useChatStream(): UseChatStreamReturn {
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingBlocks, setStreamingBlocks] = useState<ContentBlock[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingUserMessage, setPendingUserMessageRaw] =
    useState<ChatMessage | null>(null);
  const [streamStartedAt, setStreamStartedAt] = useState("");
  const [contextPercent, setContextPercent] = useState<number | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const isStreamingRef = useRef(false);
  const latestTextRef = useRef("");
  const prevPendingRef = useRef<ChatMessage | null>(null);

  // Track null→non-null transitions on pendingUserMessage to capture
  // streamStartedAt for flows that use setPendingUserMessage directly
  // (e.g., codex debate) rather than sendMessage.
  useEffect(() => {
    if (pendingUserMessage !== null && prevPendingRef.current === null) {
      setStreamStartedAt((prev) => prev || new Date().toISOString());
    }
    prevPendingRef.current = pendingUserMessage;
  }, [pendingUserMessage]);

  const setPendingUserMessage = useCallback((msg: ChatMessage | null) => {
    setPendingUserMessageRaw(msg);
  }, []);

  const stopStreaming = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const sendMessage = useCallback(
    async (
      url: string,
      body: Record<string, unknown>,
      callbacks?: UseChatStreamCallbacks
    ) => {
      if (isStreamingRef.current) {
        return;
      }

      setStreamStartedAt(new Date().toISOString());
      setIsStreaming(true);
      isStreamingRef.current = true;
      setStreamingContent("");
      setStreamingBlocks([]);
      setError(null);

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const streamHandlers = {
        onText: (accumulated: string) => {
          setStreamingContent(accumulated);
          latestTextRef.current = accumulated;
        },
        onToolUse: (tool: { name: string; input: unknown; id: string }) => {
          setStreamingBlocks((prev) => [
            ...prev,
            {
              type: "tool_use" as const,
              id: tool.id,
              name: tool.name,
              input: tool.input,
            },
          ]);
        },
        onToolResult: (result: {
          id: string;
          content: string;
          is_error: boolean;
        }) => {
          setStreamingBlocks((prev) =>
            prev.map((block) =>
              block.id === result.id
                ? {
                    ...block,
                    type: "tool_result" as const,
                    content: result.content,
                    is_error: result.is_error,
                  }
                : block
            )
          );
        },
        onThinking: (content: string) => {
          setStreamingBlocks((prev) => [
            ...prev,
            {
              type: "thinking" as const,
              id: `thinking-${Date.now()}`,
              thinking: content,
            },
          ]);
        },
        onError: (err: string) => setError(err),
        onComplete: () => {
          // Handled via result.completed
        },
        onPid: (pid: number) => callbacks?.onPid?.(pid),
        onLearnings: () => callbacks?.onLearnings?.(),
        onUsage: (pct: number) => setContextPercent(pct),
        onEvent: (event: Record<string, unknown>) =>
          callbacks?.onEvent?.(event),
      };

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: abortController.signal,
        });

        if (!response.ok) {
          throw new Error("Failed to send message");
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No response body");
        }

        // Read commandId from response header (primary channel)
        let commandId = response.headers.get("x-relay-command-id") ?? undefined;

        let result = await readChatStream(reader, streamHandlers);

        // In-band relay_meta as backup for commandId
        commandId ??= result.commandId;
        let lastSeq = result.lastSeq;

        if (result.completed) {
          const { learnings } = parseLearningsUsed(latestTextRef.current);
          if (learnings.length > 0) {
            callbacks?.onLearningsUsed?.(learnings);
          }
          await callbacks?.onComplete?.(latestTextRef.current);
          return;
        }

        if (result.terminalError) {
          // Terminal command error — do NOT reconnect
          return;
        }

        // Stream dropped without terminal event — try reconnect if relay mode
        if (commandId) {
          let attempts = 0;
          while (
            attempts < MAX_RECONNECT_ATTEMPTS &&
            !abortController.signal.aborted
          ) {
            attempts++;

            // Exponential backoff: 1s, 2s, 4s, ... capped at 30s
            const delay = Math.min(1000 * 2 ** (attempts - 1), 30_000);
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, delay);
              abortController.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true }
              );
            });
            if (abortController.signal.aborted) {
              break;
            }

            console.log(
              `[chat-stream] Reconnect attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS}`
            );

            try {
              const reconnectHeaders: Record<string, string> = {
                "Content-Type": "application/json",
                "x-relay-after-sequence": String(lastSeq ?? 0),
              };
              if (commandId) {
                reconnectHeaders["x-relay-command-id"] = commandId;
              }
              const reconnectResponse = await fetch(url, {
                method: "POST",
                headers: reconnectHeaders,
                body: JSON.stringify(body),
                signal: abortController.signal,
              });

              if (!reconnectResponse.ok) {
                console.log(
                  `[chat-stream] Reconnect response: ${reconnectResponse.status}`
                );
                // 4xx = auth/client error, stop retrying; 5xx = transient, keep trying
                if (reconnectResponse.status < 500) {
                  break;
                }
                continue;
              }

              const reconnectReader = reconnectResponse.body?.getReader();
              if (!reconnectReader) {
                break;
              }

              result = await readChatStream(reconnectReader, streamHandlers, {
                initialContent: latestTextRef.current,
              });

              commandId ??= result.commandId;
              lastSeq = result.lastSeq ?? lastSeq;

              if (result.completed) {
                setError(null);
                const { learnings } = parseLearningsUsed(latestTextRef.current);
                if (learnings.length > 0) {
                  callbacks?.onLearningsUsed?.(learnings);
                }
                await callbacks?.onComplete?.(latestTextRef.current);
                return;
              }

              if (result.terminalError) {
                return;
              }
            } catch (err) {
              if (err instanceof DOMException && err.name === "AbortError") {
                throw err;
              }
              console.error("[chat-stream] Reconnect error:", err);
              break;
            }
          }
        }

        // Reconnect exhausted — surface error (chat has no poll fallback)
        if (!(result.completed || abortController.signal.aborted)) {
          setError(
            result.lastRelayError ?? "Stream connection lost. Please try again."
          );
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // User stopped the stream — not an error
        } else {
          console.error("Chat error:", err);
          setError(
            err instanceof Error ? err.message : "Failed to send message"
          );
        }
      } finally {
        setIsStreaming(false);
        isStreamingRef.current = false;
        setStreamingContent("");
        setStreamingBlocks([]);
        setPendingUserMessageRaw(null);
        abortControllerRef.current = null;
        latestTextRef.current = "";
        setStreamStartedAt("");
      }
    },
    []
  );

  return {
    streamingContent,
    streamingBlocks,
    isStreaming,
    error,
    pendingUserMessage,
    setPendingUserMessage,
    sendMessage,
    stopStreaming,
    streamStartedAt,
    contextPercent,
  };
}
