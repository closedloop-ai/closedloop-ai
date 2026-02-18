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
  message?: { content: ClaudeBlock[] };
  delta?: { type: string; text?: string };
};

export type StreamState = {
  assistantContent: string;
  assistantBlocks: ContentBlock[];
  capturedSessionId: string | null;
  usedEditTools: boolean;
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
    onSessionId,
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

function formatToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : JSON.stringify(c, null, 2)))
      .join("\n");
  }
  if (content === null || content === undefined) {
    return "";
  }
  return JSON.stringify(content, null, 2);
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

  if (event.type === "result" && event.subtype === "success") {
    if (!state.capturedSessionId && event.session_id) {
      state.capturedSessionId = event.session_id;
      state.onSessionId?.(event.session_id);
    }
    enqueue(JSON.stringify({ type: "result", success: true }));
  }
}
