"use client";

import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatMessage, ContentBlock } from "@/components/chat/types";
import { env } from "@/env";
import { useChatRunnerToken } from "@/hooks/chat/use-chat-runner-token";
import { useChatStream } from "@/hooks/chat/use-chat-stream";
import { useApiClient } from "@/hooks/use-api-client";
import type { StreamErrorEvent } from "@/lib/chat/chat-utils";
import { DEFAULT_CHAT_MODELS } from "@/lib/chat/default-models";
import { useElectronDetection } from "@/lib/engineer/electron-detection";
import { queryKeys } from "@/lib/engineer/queries/keys";
import { useEngineerRoutingSelection } from "@/lib/engineer/routing-store";

type ChatSessionRow = {
  id: string;
  chatKey: string;
  userId: string;
  organizationId: string;
  provider: "claude" | "codex";
  model: string;
  messages: ChatMessage[];
  sessionId: string | null;
  context: string | null;
  createdAt: string;
  updatedAt: string;
};

type ChatEnvelope = { chat: ChatSessionRow | null };

export type UseChatSessionOptions = {
  chatKey: string;
  context: string;
  provider: "claude" | "codex";
  model?: string;
  cwd?: string;
  onProviderMismatch?: (boundProvider: string) => void;
};

export type UseChatSessionReturn = {
  messages: ChatMessage[];
  isLoading: boolean;
  isStreaming: boolean;
  streamingContent: string;
  streamingBlocks: ContentBlock[];
  streamStartedAt: string;
  contextPercent: number | null;
  error: string | null;
  inputValue: string;
  setInputValue: (v: string) => void;
  sendMessage: () => Promise<void>;
  stopStreaming: () => void;
  clearHistory: () => Promise<void>;
  currentProvider: string | null;
  currentModel: string | null;
};

export function useChatSession(
  options: UseChatSessionOptions
): UseChatSessionReturn {
  const { chatKey, context, provider, model, cwd, onProviderMismatch } =
    options;
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const routing = useEngineerRoutingSelection();
  const electronDetection = useElectronDetection(
    routing.mode === EngineerRoutingMode.LocalElectron
  );
  const chatStream = useChatStream();
  const runnerToken = useChatRunnerToken(chatKey);

  const [inputValue, setInputValue] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [pendingUserMessage, setPendingUserMessage] =
    useState<ChatMessage | null>(null);

  const chatKeyEnabled = chatKey.length > 0;

  const historyQuery = useQuery<ChatSessionRow | null>({
    queryKey: queryKeys.chatSessionHistory(chatKey),
    queryFn: async () => {
      const path = `/chat-sessions?chatKey=${encodeURIComponent(chatKey)}`;
      const result = await apiClient.get<ChatEnvelope>(path);
      return result.chat;
    },
    enabled: chatKeyEnabled,
  });

  const existingChat = historyQuery.data ?? null;
  // Clear the optimistic user message once the backend has persisted it and
  // the history query has caught up. Prevents the "my message disappears until
  // the stream ends" flicker on the first send.
  useEffect(() => {
    if (!pendingUserMessage) {
      return;
    }
    const persisted = existingChat?.messages.some(
      (m) => m.id === pendingUserMessage.id
    );
    if (persisted) {
      setPendingUserMessage(null);
    }
  }, [existingChat, pendingUserMessage]);

  const messages = useMemo<ChatMessage[]>(() => {
    const base = existingChat?.messages ?? [];
    if (!pendingUserMessage) {
      return base;
    }
    const alreadyPresent = base.some((m) => m.id === pendingUserMessage.id);
    if (alreadyPresent) {
      return base;
    }
    return [...base, pendingUserMessage];
  }, [existingChat, pendingUserMessage]);
  const currentProvider = existingChat?.provider ?? null;
  const currentModel = existingChat?.model ?? null;

  const invalidateHistory = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.chatSessionHistory(chatKey),
    });
  }, [queryClient, chatKey]);

  const sendMessage = useCallback(async (): Promise<void> => {
    if (!chatKeyEnabled) {
      return;
    }
    const draft = inputValue.trim();
    if (!draft) {
      return;
    }

    setLocalError(null);

    if (routing.mode === EngineerRoutingMode.LocalElectron) {
      if (!electronDetection.detected) {
        setLocalError("Local Electron gateway not detected.");
        return;
      }
    } else if (!routing.computeTargetId) {
      setLocalError("Select an online compute target to use CloudRelay");
      return;
    }

    const credentials = await runnerToken.ensureFresh();
    if (!credentials) {
      setLocalError("Failed to authorize chat session");
      return;
    }

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: draft,
      timestamp: new Date().toISOString(),
    };

    setInputValue("");
    setPendingUserMessage(userMessage);

    await chatStream.sendMessage(
      "/api/engineer/chat",
      {
        chatKey,
        userMessage,
        provider,
        model: model ?? DEFAULT_CHAT_MODELS[provider],
        context,
        cwd,
        expectedMcpUrl: env.NEXT_PUBLIC_MCP_SERVER_URL,
        apiBaseUrl: credentials.apiBaseUrl,
        apiAuthToken: credentials.token,
      },
      {
        onError: (err: StreamErrorEvent) => {
          if (err.phase === "upsert") {
            setInputValue(draft);
            setPendingUserMessage(null);
          }
          if (err.code === "PROVIDER_MISMATCH" && err.boundProvider) {
            onProviderMismatch?.(err.boundProvider);
          }
          setLocalError(err.message);
        },
      }
    );

    invalidateHistory();
  }, [
    chatKey,
    chatKeyEnabled,
    chatStream,
    context,
    cwd,
    electronDetection.detected,
    inputValue,
    invalidateHistory,
    model,
    onProviderMismatch,
    provider,
    routing.computeTargetId,
    routing.mode,
    runnerToken,
  ]);

  const clearHistory = useCallback(async (): Promise<void> => {
    if (!chatKeyEnabled) {
      return;
    }
    try {
      await apiClient.delete(
        `/chat-sessions?chatKey=${encodeURIComponent(chatKey)}`
      );
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : "Failed to clear history"
      );
      return;
    }
    invalidateHistory();
  }, [apiClient, chatKey, chatKeyEnabled, invalidateHistory]);

  const mergedError = localError ?? chatStream.error;

  return {
    messages,
    isLoading: chatKeyEnabled && historyQuery.isLoading,
    isStreaming: chatStream.isStreaming,
    streamingContent: chatStream.streamingContent,
    streamingBlocks: chatStream.streamingBlocks,
    streamStartedAt: chatStream.streamStartedAt,
    contextPercent: chatStream.contextPercent,
    error: mergedError,
    inputValue,
    setInputValue,
    sendMessage,
    stopStreaming: chatStream.stopStreaming,
    clearHistory,
    currentProvider,
    currentModel,
  };
}
