/**
 * Client-side Terminal Stream Reader
 *
 * Handles two modes: Claude (default) and Codex (@codex).
 */

export type TerminalMode = "claude" | "codex";

export type TerminalStreamEvent = {
  type: string;
  content?: string;
  status?: string;
  error?: string;
  mode?: TerminalMode;
  pid?: number;
  // Claude stream events
  name?: string;
  input?: unknown;
  id?: string;
  is_error?: boolean;
};

export type TerminalStreamHandlers = {
  /** Claude/Codex text content (accumulated) */
  onText: (content: string) => void;
  /** Tool use block from Claude */
  onToolUse?: (tool: { name: string; input: unknown; id: string }) => void;
  /** Tool result from Claude */
  onToolResult?: (result: {
    id: string;
    content: string;
    is_error: boolean;
  }) => void;
  /** Thinking block from Claude */
  onThinking?: (content: string) => void;
  /** Clear screen event */
  onClear: () => void;
  /** Error */
  onError: (error: string) => void;
  /** Stream complete */
  onComplete: () => void;
  /** Process PID */
  onPid?: (pid: number) => void;
  /** Status update */
  onStatus?: (status: string, mode?: TerminalMode) => void;
};

/**
 * Read a streaming response from the terminal-chat API.
 * Handles both Claude and Codex modes.
 */
export async function readTerminalStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  handlers: TerminalStreamHandlers
): Promise<void> {
  const decoder = new TextDecoder();
  let accumulated = "";
  let buffer = "";

  const parseLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }

    try {
      const event: TerminalStreamEvent = JSON.parse(line);
      accumulated = dispatchTerminalEvent(event, accumulated, handlers);
    } catch {
      // Not JSON — ignore
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      parseLine(line);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  // Flush decoder and parse any trailing line without newline terminator.
  buffer += decoder.decode();
  parseLine(buffer);
}

function dispatchTerminalEvent(
  event: TerminalStreamEvent,
  accumulated: string,
  handlers: TerminalStreamHandlers
): string {
  let result = accumulated;
  if (event.type === "clear") {
    handlers.onClear();
  } else if (event.type === "text" && event.content) {
    result += event.content;
    handlers.onText(result);
  } else if (
    event.type === "tool_use" &&
    handlers.onToolUse &&
    event.name &&
    event.id
  ) {
    handlers.onToolUse({ name: event.name, input: event.input, id: event.id });
  } else if (
    event.type === "tool_result" &&
    handlers.onToolResult &&
    event.id
  ) {
    handlers.onToolResult({
      id: event.id,
      content: formatToolResultContent(event.content),
      is_error: event.is_error ?? false,
    });
  } else if (
    event.type === "thinking" &&
    event.content &&
    handlers.onThinking
  ) {
    handlers.onThinking(event.content);
  } else if (event.type === "status") {
    if (event.pid && handlers.onPid) {
      handlers.onPid(event.pid);
    }
    handlers.onStatus?.(event.status || "", event.mode);
  } else if (event.type === "error" && event.error) {
    handlers.onError(event.error);
  } else if (event.type === "result" || event.type === "done") {
    handlers.onComplete();
  }
  return result;
}

function formatToolResultContent(content: unknown): string {
  if (content === null || content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : JSON.stringify(c, null, 2)))
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}
