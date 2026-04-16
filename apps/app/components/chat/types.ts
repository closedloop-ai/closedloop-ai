import type { ChatMessage as BaseChatMessage } from "@repo/api/src/types/chat-session";

/**
 * Shared types for chat components
 */

/**
 * A chat message between user and assistant. Extends the API-side
 * persisted base with optional UI-only fields.
 */
export interface ChatMessage extends BaseChatMessage {
  mentions?: string[];
  blocks?: ContentBlock[];
  sender?: "claude" | "codex";
  responded?: boolean;
}

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
