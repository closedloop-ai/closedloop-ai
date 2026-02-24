import type { ChildProcess } from "node:child_process";
import { formatToolResultContent } from "@/lib/engineer/chat-utils";

export type ContentBlock = {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string;
  is_error?: boolean;
};

type ClaudeBlock = {
  type: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  thinking?: string;
  text?: string;
};

type ClaudeStreamEvent = {
  type: string;
  sessionId?: string;
  session_id?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  message?: { content: ClaudeBlock[] };
  delta?: { type: string; text?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  context_window?: number;
};

export type StreamState = {
  assistantContent: string;
  assistantBlocks: ContentBlock[];
  capturedSessionId: string | null;
  usedEditTools: boolean;
  contextPercent: number | null;
  onSessionId?: (sessionId: string) => void;
  onResultEvent?: () => void;
};

export function createStreamState(
  onSessionId?: (sessionId: string) => void,
  onResultEvent?: () => void
): StreamState {
  return {
    assistantContent: "",
    assistantBlocks: [],
    capturedSessionId: null,
    usedEditTools: false,
    contextPercent: null,
    onSessionId,
    onResultEvent,
  };
}

export function makeResultKillTimer(
  getProcess: () => ChildProcess | null,
  label: string
): () => void {
  return () => {
    const proc = getProcess();
    if (!proc) {
      return;
    }
    const killTimer = setTimeout(() => {
      console.warn(`[${label}] Kill timeout: SIGTERM after result event`);
      try {
        proc.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, 5000);
    }, 30_000);
    proc.once("close", () => clearTimeout(killTimer));
  };
}

function processToolUseBlock(
  block: ClaudeBlock,
  state: StreamState,
  enqueue: (msg: string) => void
) {
  if (block.name && ["Edit", "Write"].includes(block.name)) {
    state.usedEditTools = true;
  }
  // Accumulate in state for history
  state.assistantBlocks.push({
    type: "tool_use",
    id: block.id,
    name: block.name,
    input: block.input,
  });
  // Emit to client
  enqueue(
    JSON.stringify({
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input,
    })
  );
}

function processToolResultBlock(
  block: ClaudeBlock,
  state: StreamState,
  enqueue: (msg: string) => void
) {
  // Accumulate in state for history
  state.assistantBlocks.push({
    type: "tool_result",
    id: block.tool_use_id,
    content: formatToolResultContent(block.content),
    is_error: block.is_error,
  });
  // Emit to client
  enqueue(
    JSON.stringify({
      type: "tool_result",
      id: block.tool_use_id,
      content: block.content,
      is_error: block.is_error,
    })
  );
}

function processThinkingBlock(
  block: ClaudeBlock,
  state: StreamState,
  enqueue: (msg: string) => void
) {
  // Accumulate in state for history
  state.assistantBlocks.push({
    type: "thinking",
    thinking: block.thinking,
  });
  // Emit to client
  enqueue(
    JSON.stringify({
      type: "thinking",
      content: block.thinking,
    })
  );
}

function processTextBlock(
  block: ClaudeBlock,
  state: StreamState,
  enqueue: (msg: string) => void
) {
  const text = block.text ?? "";
  const textToAdd =
    state.assistantContent && !state.assistantContent.endsWith("\n")
      ? `\n\n${text}`
      : text;
  state.assistantContent += textToAdd;
  // Accumulate in state for history
  state.assistantBlocks.push({
    type: "text",
    text: textToAdd,
  });
  enqueue(JSON.stringify({ type: "text", content: textToAdd }));
}

function processAssistantBlocks(
  blocks: ClaudeBlock[],
  state: StreamState,
  enqueue: (msg: string) => void
) {
  for (const block of blocks) {
    if (block.type === "tool_use") {
      processToolUseBlock(block, state, enqueue);
    } else if (block.type === "tool_result") {
      processToolResultBlock(block, state, enqueue);
    } else if (block.type === "thinking" && block.thinking) {
      processThinkingBlock(block, state, enqueue);
    } else if (block.type === "text" && block.text) {
      processTextBlock(block, state, enqueue);
    }
  }
}

export function processStreamEvent(
  event: ClaudeStreamEvent,
  state: StreamState,
  enqueue: (msg: string) => void
) {
  if (event.type === "init" && event.sessionId) {
    state.capturedSessionId = event.sessionId;
    state.onSessionId?.(event.sessionId);
    return;
  }

  if (event.type === "assistant" && event.message?.content) {
    processAssistantBlocks(event.message.content, state, enqueue);
    return;
  }

  // Claude CLI emits tool results as user-role messages
  if (event.type === "user" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "tool_result") {
        processToolResultBlock(block, state, enqueue);
      }
    }
    return;
  }

  if (
    event.type === "content_block_delta" &&
    event.delta?.type === "text_delta"
  ) {
    const deltaText = event.delta.text;
    if (deltaText) {
      state.assistantContent += deltaText;
      enqueue(JSON.stringify({ type: "text", content: deltaText }));
    }
    return;
  }

  if (event.type === "result") {
    // Always capture session ID first (even for errors)
    if (!state.capturedSessionId && event.session_id) {
      state.capturedSessionId = event.session_id;
      state.onSessionId?.(event.session_id);
    }

    // Detect context limit / error results (e.g. "Prompt is too long")
    if (event.is_error) {
      const errorText =
        typeof event.result === "string"
          ? event.result
          : "Claude encountered an error";
      enqueue(JSON.stringify({ type: "error", error: errorText }));
      state.onResultEvent?.();
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
    } else {
      console.warn(
        `[stream-events] Unrecognized result subtype: ${event.subtype}`
      );
      enqueue(JSON.stringify({ type: "result", success: false }));
    }
    state.onResultEvent?.();
  }
}
