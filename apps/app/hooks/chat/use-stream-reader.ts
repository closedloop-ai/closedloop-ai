"use client";

import { type Dispatch, useCallback, useRef } from "react";
import {
  parseLearningsUsed,
  type ReadChatStreamResult,
  readChatStream,
  type StreamErrorEvent,
} from "@/lib/chat/chat-utils";
import type { ChatStreamAction } from "./chat-stream-reducer";
import type { UseChatStreamCallbacks } from "./use-chat-stream";

/**
 * Encapsulates the ReadableStream consumption loop. Owns the
 * `latestText` and `upsertFailed` refs so sibling hooks can keep using
 * plain callback references across rerenders without rebuilding
 * handlers on every read. Exposes `readStream` which wires the reducer
 * dispatch to `readChatStream`.
 */
export function useStreamReader(dispatch: Dispatch<ChatStreamAction>) {
  const latestTextRef = useRef("");
  const upsertFailedRef = useRef(false);

  const reset = useCallback(() => {
    latestTextRef.current = "";
    upsertFailedRef.current = false;
  }, []);

  const getLatestText = useCallback(() => latestTextRef.current, []);
  const wasUpsertFailed = useCallback(() => upsertFailedRef.current, []);

  const readStream = useCallback(
    (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      callbacks: UseChatStreamCallbacks | undefined,
      options?: { initialContent?: string }
    ): Promise<ReadChatStreamResult> => {
      const handlers = {
        onText: (accumulated: string) => {
          dispatch({ type: "text/update", content: accumulated });
          latestTextRef.current = accumulated;
        },
        onToolUse: (tool: { name: string; input: unknown; id: string }) => {
          dispatch({ type: "block/addToolUse", tool });
        },
        onToolResult: (result: {
          id: string;
          content: string;
          is_error: boolean;
        }) => {
          dispatch({ type: "block/updateToolResult", result });
        },
        onThinking: (content: string) => {
          dispatch({
            type: "block/addThinking",
            id: `thinking-${Date.now()}`,
            content,
          });
        },
        onError: (err: StreamErrorEvent) => {
          dispatch({ type: "error/set", message: err.message });
          if (err.phase === "upsert") {
            upsertFailedRef.current = true;
          }
          callbacks?.onError?.(err);
        },
        onComplete: () => {
          // Terminal completion is surfaced via `readChatStream` result.
        },
        onPid: (pid: number) => callbacks?.onPid?.(pid),
        onLearnings: () => callbacks?.onLearnings?.(),
        onUsage: (pct: number) => dispatch({ type: "usage/set", percent: pct }),
        onEvent: (event: Record<string, unknown>) =>
          callbacks?.onEvent?.(event),
      };
      return options?.initialContent === undefined
        ? readChatStream(reader, handlers)
        : readChatStream(reader, handlers, {
            initialContent: options.initialContent,
          });
    },
    [dispatch]
  );

  const emitLearningsUsed = useCallback(
    (callbacks: UseChatStreamCallbacks | undefined) => {
      const { learnings } = parseLearningsUsed(latestTextRef.current);
      if (learnings.length > 0) {
        callbacks?.onLearningsUsed?.(learnings);
      }
    },
    []
  );

  return {
    readStream,
    reset,
    getLatestText,
    wasUpsertFailed,
    emitLearningsUsed,
  };
}
