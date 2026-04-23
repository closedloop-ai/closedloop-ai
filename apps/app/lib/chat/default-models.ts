/**
 * Canonical default models used by the useChatSession hook
 * (apps/app/hooks/chat/use-chat-session.ts). The hook resolves `model`
 * via `body.model ?? DEFAULT_CHAT_MODELS[provider]` before POSTing to
 * /api/gateway/chat, so the gateway always receives an explicit
 * non-empty model string.
 */
export const DEFAULT_CHAT_MODELS = {
  claude: "claude-sonnet-4-5",
  codex: "gpt-5.5",
} as const satisfies Record<string, string>;

export type DefaultChatModelProvider = keyof typeof DEFAULT_CHAT_MODELS;
