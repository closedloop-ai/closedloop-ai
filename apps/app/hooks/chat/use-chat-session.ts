"use client";

import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import {
  chatSessionReducer,
  initialChatSessionState,
} from "@repo/app/chat/hooks/chat-session-reducer";
import { DEFAULT_CHAT_MODELS } from "@repo/app/chat/lib/default-models";
import type { ChatMessage, ContentBlock } from "@repo/app/chat/lib/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useReducer } from "react";
import type { PrCommentContext } from "@/app/(authenticated)/[orgSlug]/build/[id]/comment-context";
import { env } from "@/env";
import { useChatRunnerToken } from "@/hooks/chat/use-chat-runner-token";
import { useChatStream } from "@/hooks/chat/use-chat-stream";
import { useApiClient } from "@/hooks/use-api-client";
import type { StreamErrorEvent } from "@/lib/chat/chat-utils";
import { useElectronDetection } from "@/lib/engineer/electron-detection";
import { queryKeys } from "@/lib/engineer/queries/keys";
import { useEngineerRoutingSelection } from "@/lib/engineer/routing-store";

function buildUserMessageContent(
  draft: string,
  contextSelection: PrCommentContext | null | undefined
): string {
  if (!contextSelection) {
    return draft;
  }
  const { filePath, line, body } = contextSelection;
  const locationSuffix = filePath
    ? ` on ${filePath}${line ? `:${line}` : ""}`
    : "";
  return `[Selected PR comment${locationSuffix}]:\n${body}\n\n---\n${draft}`;
}

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
  contextSelection?: PrCommentContext | null;
  onContextConsumed?: () => void;
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
  const {
    chatKey,
    context,
    provider,
    model,
    cwd,
    onProviderMismatch,
    contextSelection,
    onContextConsumed,
  } = options;
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const routing = useEngineerRoutingSelection();
  const electronDetection = useElectronDetection(
    routing.mode === EngineerRoutingMode.LocalElectron
  );
  const chatStream = useChatStream();
  const runnerToken = useChatRunnerToken(chatKey);

  const [state, dispatch] = useReducer(
    chatSessionReducer,
    initialChatSessionState
  );
  const { inputValue, localError, pendingUserMessage } = state;

  const chatKeyEnabled = chatKey.length > 0;

  const historyQuery = useQuery<ChatSessionRow | null>({
    queryKey: queryKeys.chatSessionHistory(chatKey),
    queryFn: async () => {
      const path = `/chat-sessions?chatKey=${encodeURIComponent(chatKey)}`;
      const result = await apiClient.get<ChatEnvelope>(path);
      const chat = result.chat;
      // Clear the optimistic user message once the backend has persisted
      // it and the history query has caught up. Prevents the "my message
      // disappears until the stream ends" flicker on the first send.
      if (
        pendingUserMessage &&
        chat?.messages.some((m) => m.id === pendingUserMessage.id)
      ) {
        dispatch({ type: "pending/clear" });
      }
      return chat;
    },
    enabled: chatKeyEnabled,
  });

  const existingChat = historyQuery.data ?? null;

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

  const setInputValue = useCallback((v: string) => {
    dispatch({ type: "input/set", value: v });
  }, []);

  const sendMessage = useCallback(async (): Promise<void> => {
    if (!chatKeyEnabled) {
      return;
    }
    const draft = inputValue.trim();
    if (!draft) {
      return;
    }

    dispatch({ type: "error/set", message: null });

    if (routing.mode === EngineerRoutingMode.LocalElectron) {
      if (!electronDetection.detected) {
        dispatch({
          type: "error/set",
          message: "Local Electron gateway not detected.",
        });
        return;
      }
    } else if (!routing.computeTargetId) {
      dispatch({
        type: "error/set",
        message: "Select an online compute target to use CloudRelay",
      });
      return;
    }

    const credentials = await runnerToken.ensureFresh();
    if (!credentials) {
      dispatch({
        type: "error/set",
        message: "Failed to authorize chat session",
      });
      return;
    }

    const userMessage: ChatMessage = {
      id: `user-${crypto.randomUUID()}`,
      role: "user",
      content: buildUserMessageContent(draft, contextSelection),
      timestamp: new Date().toISOString(),
    };

    dispatch({ type: "send/start", message: userMessage });

    const result = await chatStream.sendMessage(
      "/api/gateway/chat",
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
            dispatch({
              type: "upsertFailure/restoreDraft",
              draft,
              message: err.message,
            });
          } else {
            dispatch({ type: "error/set", message: err.message });
          }
          if (err.code === "PROVIDER_MISMATCH" && err.boundProvider) {
            onProviderMismatch?.(err.boundProvider);
          }
        },
      }
    );

    if (result.ok) {
      onContextConsumed?.();
    }

    invalidateHistory();
  }, [
    chatKey,
    chatKeyEnabled,
    chatStream,
    context,
    contextSelection,
    cwd,
    electronDetection.detected,
    inputValue,
    invalidateHistory,
    model,
    onContextConsumed,
    onProviderMismatch,
    provider,
    routing.computeTargetId,
    routing.mode,
    runnerToken,
  ]);

  const clearHistoryMutation = useMutation({
    mutationFn: () =>
      apiClient.delete(`/chat-sessions?chatKey=${encodeURIComponent(chatKey)}`),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.chatSessionHistory(chatKey),
      });
    },
  });

  const clearHistory = useCallback(async (): Promise<void> => {
    if (!chatKeyEnabled) {
      return;
    }
    // Use mutateAsync so callers that `await clearHistory()` actually
    // wait for the DELETE to complete. The global QueryClient
    // `mutations.onError` handler in `lib/query-client.tsx` toasts any
    // failure, so we swallow the rejection here to avoid requiring
    // every caller to wrap this in try/catch.
    try {
      await clearHistoryMutation.mutateAsync();
    } catch {
      // Intentional: global onError handler already surfaced the error.
    }
  }, [chatKeyEnabled, clearHistoryMutation]);

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
