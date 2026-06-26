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

export type ClaudeBlock = {
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

export type ClaudeStreamEvent = {
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

export function formatToolResultContent(content: unknown): string {
  if (content === null || content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((entry) =>
        typeof entry === "string" ? entry : JSON.stringify(entry, null, 2)
      )
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}
