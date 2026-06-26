import {
  type ClaudeStreamEvent,
  type ContentBlock,
  formatToolResultContent,
} from "@closedloop-ai/loops-api/stream-types";
import { AUTH_CHALLENGE_PATTERN } from "./symphony-loop.js";

export type StreamState = {
  assistantContent: string;
  assistantBlocks: ContentBlock[];
  capturedSessionId: string | null;
  usedEditTools: boolean;
  contextPercent: number | null;
  authChallengeDetected: boolean;
  onSessionId?: (sessionId: string) => void;
};

export function createStreamState(
  onSessionId?: (sessionId: string) => void
): StreamState {
  return {
    assistantContent: "",
    assistantBlocks: [],
    capturedSessionId: null,
    usedEditTools: false,
    contextPercent: null,
    authChallengeDetected: false,
    onSessionId,
  };
}

export function processStreamEvent(
  event: ClaudeStreamEvent,
  state: StreamState,
  enqueue: (msg: string) => void
): void {
  if (event.type === "init" && event.sessionId) {
    state.capturedSessionId = event.sessionId;
    state.onSessionId?.(event.sessionId);
    enqueue(JSON.stringify({ type: "sessionId", sessionId: event.sessionId }));
    return;
  }

  if (event.type === "assistant" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "tool_use") {
        state.assistantBlocks.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });
        enqueue(
          JSON.stringify({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          })
        );
        continue;
      }

      if (block.type === "tool_result") {
        const content = formatToolResultContent(block.content);
        state.assistantBlocks.push({
          type: "tool_result",
          id: block.tool_use_id,
          content,
          is_error: block.is_error,
        });
        enqueue(
          JSON.stringify({
            type: "tool_result",
            id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error,
          })
        );
        continue;
      }

      if (block.type === "thinking" && block.thinking) {
        state.assistantBlocks.push({
          type: "thinking",
          thinking: block.thinking,
        });
        enqueue(JSON.stringify({ type: "thinking", content: block.thinking }));
        continue;
      }

      if (block.type === "text" && block.text) {
        const textToAdd =
          state.assistantContent && !state.assistantContent.endsWith("\n")
            ? `\n\n${block.text}`
            : block.text;
        state.assistantContent += textToAdd;
        state.assistantBlocks.push({ type: "text", text: textToAdd });
        enqueue(JSON.stringify({ type: "text", content: textToAdd }));
      }
    }
    return;
  }

  if (event.type === "user" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type !== "tool_result") {
        continue;
      }
      enqueue(
        JSON.stringify({
          type: "tool_result",
          id: block.tool_use_id,
          content: block.content,
          is_error: block.is_error,
        })
      );
    }
    return;
  }

  if (
    event.type === "content_block_delta" &&
    event.delta?.type === "text_delta"
  ) {
    if (event.delta.text) {
      state.assistantContent += event.delta.text;
      enqueue(JSON.stringify({ type: "text", content: event.delta.text }));
    }
    return;
  }

  if (event.type === "result") {
    if (!state.capturedSessionId && event.session_id) {
      state.capturedSessionId = event.session_id;
      state.onSessionId?.(event.session_id);
      enqueue(
        JSON.stringify({ type: "sessionId", sessionId: event.session_id })
      );
    }

    if (event.is_error) {
      const errorText =
        typeof event.result === "string"
          ? event.result
          : "Claude encountered an error";
      if (AUTH_CHALLENGE_PATTERN.test(errorText)) {
        state.authChallengeDetected = true;
      }
      enqueue(JSON.stringify({ type: "error", error: errorText }));
      return;
    }

    if (event.subtype === "success") {
      if (event.usage) {
        const total =
          (event.usage.input_tokens ?? 0) +
          (event.usage.output_tokens ?? 0) +
          (event.usage.cache_creation_input_tokens ?? 0) +
          (event.usage.cache_read_input_tokens ?? 0);
        const contextWindow = event.context_window ?? 200_000;
        const percent =
          contextWindow > 0 ? Math.round((total * 100) / contextWindow) : 0;
        state.contextPercent = percent;
        enqueue(JSON.stringify({ type: "usage", contextPercent: percent }));
      }
      enqueue(JSON.stringify({ type: "result", success: true }));
      return;
    }

    enqueue(JSON.stringify({ type: "result", success: false }));
  }
}
