"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatMessage,
  ContentBlock,
} from "@/components/engineer/chat/types";
import type { LearningUsed } from "@/lib/engineer/chat-utils";
import { parseLearningsUsed, readChatStream } from "@/lib/engineer/chat-utils";

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
      let streamCompleted = false;

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

        await readChatStream(reader, {
          onText: (accumulated) => {
            setStreamingContent(accumulated);
            latestTextRef.current = accumulated;
          },
          onToolUse: (tool) => {
            setStreamingBlocks((prev) => [
              ...prev,
              {
                type: "tool_use",
                id: tool.id,
                name: tool.name,
                input: tool.input,
              },
            ]);
          },
          onToolResult: (result) => {
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
          onThinking: (content) => {
            setStreamingBlocks((prev) => [
              ...prev,
              {
                type: "thinking",
                id: `thinking-${Date.now()}`,
                thinking: content,
              },
            ]);
          },
          onError: (err) => setError(err),
          onComplete: () => {
            streamCompleted = true;
          },
          onPid: (pid) => callbacks?.onPid?.(pid),
          onLearnings: () => callbacks?.onLearnings?.(),
          onUsage: (pct) => setContextPercent(pct),
          onEvent: (event) => callbacks?.onEvent?.(event),
        });

        // Await consumer cleanup (e.g. query invalidation) BEFORE finally
        // clears streaming state, so the UI transitions seamlessly from
        // streaming content to cached query data with no flash.
        if (streamCompleted) {
          const { learnings } = parseLearningsUsed(latestTextRef.current);
          if (learnings.length > 0) {
            callbacks?.onLearningsUsed?.(learnings);
          }
          await callbacks?.onComplete?.(latestTextRef.current);
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
