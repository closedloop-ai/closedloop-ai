/**
 * Shared Codex NDJSON stream reader.
 *
 * Extracts the duplicated Codex parsing logic from CommentChat, ClosedLoopChat,
 * and use-codex-debate into a single correct implementation that uses
 * readNdjsonLines (proper chunk buffering) instead of chunk.split("\n").
 */

import type { ChatMessage, ContentBlock } from "@/components/chat/types";
import { readNdjsonLines } from "@/lib/chat/stream-utils";

export type CodexStreamState = {
  accumulated: string;
  receivedAnyText: boolean;
  reasoningBlocks: ContentBlock[];
};

export function createCodexStreamState(): CodexStreamState {
  return {
    accumulated: "",
    receivedAnyText: false,
    reasoningBlocks: [],
  };
}

export type CodexStreamCallbacks = {
  setPending: (msg: ChatMessage | null) => void;
  saveFinalMessage: (msg: ChatMessage) => Promise<void>;
  onError?: (error: string) => void;
  onEmptyResponse?: (exitCode: number | undefined) => void;
  onComplete?: (finalContent: string) => void;
  onDoneEvent?: (event: Record<string, unknown>) => void;
};

function makeStreamingMessage(state: CodexStreamState): ChatMessage {
  return {
    id: "codex-chat-streaming",
    role: "assistant",
    content: state.accumulated,
    timestamp: new Date().toISOString(),
    sender: "codex",
    blocks:
      state.reasoningBlocks.length > 0 ? [...state.reasoningBlocks] : undefined,
  };
}

async function processEvent(
  event: Record<string, unknown>,
  state: CodexStreamState,
  callbacks: CodexStreamCallbacks
): Promise<void> {
  if (event.type === "reasoning" && event.content) {
    state.reasoningBlocks.push({
      type: "thinking",
      id: `reasoning-${Date.now()}-${state.reasoningBlocks.length}`,
      thinking: event.content as string,
    });
    callbacks.setPending(makeStreamingMessage(state));
    return;
  }
  if (event.type === "text" && event.content) {
    state.receivedAnyText = true;
    state.accumulated += event.content as string;
    callbacks.setPending(makeStreamingMessage(state));
    return;
  }
  if (event.type === "error") {
    callbacks.onError?.(String(event.error).slice(0, 200));
    return;
  }
  if (event.type !== "done") {
    return;
  }

  // Handle "done" event
  callbacks.onDoneEvent?.(event);
  const finalContent =
    (event.content as string | undefined) || state.accumulated;
  callbacks.setPending(null);
  if (finalContent.trim()) {
    await callbacks.saveFinalMessage({
      id: `codex-${Date.now()}`,
      role: "assistant",
      content: finalContent.trim(),
      timestamp: new Date().toISOString(),
      sender: "codex",
      blocks:
        state.reasoningBlocks.length > 0 ? state.reasoningBlocks : undefined,
    });
    callbacks.onComplete?.(finalContent.trim());
  } else if (!state.receivedAnyText) {
    callbacks.onEmptyResponse?.(event.exitCode as number | undefined);
  }
}

/**
 * Read a Codex NDJSON stream using proper buffered line splitting.
 * The caller owns the mutable `state` object so it can be read in
 * catch blocks (e.g., on AbortError for partial-save scenarios).
 */
export async function readCodexStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: CodexStreamState,
  callbacks: CodexStreamCallbacks
): Promise<void> {
  for await (const line of readNdjsonLines(reader)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    await processEvent(event, state, callbacks);
  }
}
