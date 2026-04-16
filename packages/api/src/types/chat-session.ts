/**
 * Shared chat-session contract between the API backend and frontend.
 *
 * The canonical shape for a persisted chat message lives here so that
 * `apps/api/app/chat-sessions/service.ts` (DB writer) and
 * `apps/app/components/chat/types.ts` (renderer) cannot drift. The
 * frontend extends this base with optional UI-only fields
 * (`mentions`, `sender`, `responded`).
 */
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  blocks?: unknown[];
};

/**
 * Provider enum shared by the API validators, service layer, and UI.
 * Values are the persisted provider identifiers.
 */
export const ChatProvider = {
  Claude: "claude",
  Codex: "codex",
} as const;
export type ChatProvider = (typeof ChatProvider)[keyof typeof ChatProvider];

export const CHAT_PROVIDER_VALUES = Object.values(ChatProvider) as [
  ChatProvider,
  ...ChatProvider[],
];
