import { queryOptions } from "@tanstack/react-query";
import type { ContentBlock } from "@/components/chat/types";
import { queryKeys } from "./keys";

/* ---------- Response types ---------- */

export type TerminalMessageMode = "claude" | "codex";

export type TerminalMessage = {
  id: string;
  role: "user" | "assistant" | "shell"; // "shell" kept for old history compat
  content: string;
  timestamp: string;
  mode?: TerminalMessageMode | "shell"; // old entries may have "shell"
  exitCode?: number; // old entries may have exitCode
  blocks?: ContentBlock[];
};

export type TerminalChatHistory = {
  messages: TerminalMessage[];
  claudeSessionId?: string;
  codexSessionId?: string;
};

/* ---------- Query option factories ---------- */

export function terminalChatHistoryOptions() {
  return queryOptions<TerminalChatHistory>({
    queryKey: queryKeys.terminalChatHistory(),
    queryFn: async () => {
      const response = await fetch("/api/gateway/terminal-chat");
      if (!response.ok) {
        // Terminal history is a non-blocking convenience read; keep the legacy
        // empty-history fallback so chat surfaces can still render offline.
        return { messages: [] };
      }
      return response.json();
    },
  });
}
