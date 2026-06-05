/**
 * Shared types for chat components
 */

/**
 * A chat message between user and assistant
 */
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  mentions?: string[];
  blocks?: ContentBlock[];
  sender?: "claude" | "codex";
  responded?: boolean;
};

/**
 * Content block from Claude's structured message format.
 * Used for tool_use, tool_result, thinking, and text blocks in chat messages.
 */
export type ContentBlock = {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string | unknown[];
  is_error?: boolean;
};
