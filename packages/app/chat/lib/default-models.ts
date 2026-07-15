/**
 * Canonical default models used by the useChatSession hook
 * (apps/app/hooks/chat/use-chat-session.ts). The hook resolves `model`
 * via `body.model ?? DEFAULT_CHAT_MODELS[provider]` before POSTing to
 * /api/gateway/chat, so the gateway always receives an explicit
 * non-empty model string.
 */
export const DEFAULT_CHAT_MODELS = {
  claude: "claude-sonnet-4-5",
  codex: "gpt-5.3-codex",
} as const satisfies Record<string, string>;

export type ChatProviderName = keyof typeof DEFAULT_CHAT_MODELS;

export type ChatModelOption = {
  /** Model id sent to the gateway (must satisfy the provider's `supportsModel`). */
  readonly value: string;
  /** Human-facing label shown in the in-composer model picker. */
  readonly label: string;
};

/**
 * Models offered by the in-composer model picker, grouped by the provider the
 * chat is bound to. Provider stays pinned per chat (the "clear chat to switch
 * providers" rule); this list only lets a user switch model *within* a
 * provider. Each provider's `DEFAULT_CHAT_MODELS` entry is included as the
 * first (default) option, and every value matches the backend's prefix-based
 * `supportsModel` checks (apps/desktop/src/server/operations/chat-providers.ts).
 */
export const CHAT_MODEL_OPTIONS = {
  claude: [
    { value: "claude-sonnet-4-5", label: "Sonnet 4.5" },
    { value: "claude-opus-4-5", label: "Opus 4.5" },
  ],
  codex: [
    { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { value: "gpt-5-codex", label: "GPT-5 Codex" },
  ],
} as const satisfies Record<ChatProviderName, readonly ChatModelOption[]>;
