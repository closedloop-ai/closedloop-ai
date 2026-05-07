"use client";

import { useCallback, useReducer } from "react";
import type { ChatMessage, ContentBlock } from "@/components/chat/types";
import type { LearningUsed, StreamErrorEvent } from "@/lib/chat/chat-utils";
import {
  chatStreamReducer,
  initialChatStreamState,
} from "./chat-stream-reducer";
import { useAbortController } from "./use-abort-controller";
import { useStreamDispatch } from "./use-stream-dispatch";
import { useStreamReader } from "./use-stream-reader";

/**
 * Discriminated result type returned by `sendMessage`. Callers use this
 * to decide whether the post-send side effects (clearing selected
 * context, etc.) should run. `ok: true` means the stream completed (or
 * was user-aborted); `ok: false` surfaces the specific failure mode so
 * callers can preserve context for retry.
 */
export type SendMessageResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "transport"
        | "http"
        | "stream-read"
        | "upsert"
        | "already-streaming";
    };

export type UseChatStreamCallbacks = {
  /** Called when streaming completes. Receives the accumulated assistant text. */
  onComplete?: (accumulatedText: string) => void | Promise<void>;
  onPid?: (pid: number) => void;
  onLearnings?: () => void;
  onLearningsUsed?: (learnings: LearningUsed[]) => void;
  /** Called when the stream surfaces a structured error event. The
   *  hook always updates its internal `error` state with `err.message`;
   *  callers opt in here to inspect phase/code/boundProvider. */
  onError?: (err: StreamErrorEvent) => void;
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
  ) => Promise<SendMessageResult>;
  stopStreaming: () => void;
  /** Stable timestamp captured once when streaming begins */
  streamStartedAt: string;
  /** Context window usage percentage (0-100), updated after each turn */
  contextPercent: number | null;
};

/**
 * Shared hook encapsulating the streaming chat pattern used by
 * TicketChatDialog, CodexReviewDialog, and ClosedLoopChat.
 *
 * Composes the chat-stream reducer with three focused sub-hooks:
 * `useAbortController` owns the `AbortController` lifecycle,
 * `useStreamReader` wires `readChatStream` events into reducer actions,
 * and `useStreamDispatch` runs the outbound fetch + reconnect loop and
 * produces the `SendMessageResult` discriminated union.
 */
export function useChatStream(): UseChatStreamReturn {
  const [state, dispatch] = useReducer(
    chatStreamReducer,
    initialChatStreamState
  );
  const abortController = useAbortController();
  const streamReader = useStreamReader(dispatch);
  const { sendMessage } = useStreamDispatch({
    dispatch,
    abortController,
    streamReader,
  });

  const setPendingUserMessage = useCallback((msg: ChatMessage | null) => {
    dispatch({
      type: "pendingMessage/set",
      message: msg,
      now: new Date().toISOString(),
    });
  }, []);

  return {
    streamingContent: state.streamingContent,
    streamingBlocks: state.streamingBlocks,
    isStreaming: state.isStreaming,
    error: state.error,
    pendingUserMessage: state.pendingUserMessage,
    setPendingUserMessage,
    sendMessage,
    stopStreaming: abortController.abort,
    streamStartedAt: state.streamStartedAt,
    contextPercent: state.contextPercent,
  };
}
