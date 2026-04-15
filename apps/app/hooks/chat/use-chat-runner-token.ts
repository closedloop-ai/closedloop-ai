import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { queryKeys } from "@/lib/engineer/queries/keys";

/**
 * Chat runner tokens are signed for 4h (see `issueChatRunnerToken`). We keep
 * the cached value fresh for 3h50m so in-flight requests never race an
 * expiry. `ensureFresh` additionally refetches when fewer than 10 minutes
 * remain.
 */
const STALE_TIME_MS = 3 * 60 * 60 * 1000 + 50 * 60 * 1000;
const REFRESH_THRESHOLD_MS = 10 * 60 * 1000;

export type ChatRunnerTokenResponse = {
  token: string;
  apiBaseUrl: string;
  expiresAt: string;
};

export type ChatRunnerCredentials = {
  token: string;
  apiBaseUrl: string;
};

async function fetchChatRunnerToken(
  chatKey: string
): Promise<ChatRunnerTokenResponse> {
  const response = await fetch("/api/chat/runner-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatKey }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to mint chat runner token: ${response.status} ${text}`.trim()
    );
  }
  return (await response.json()) as ChatRunnerTokenResponse;
}

export function useChatRunnerToken(chatKey: string) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.chatRunnerToken(chatKey);

  const query = useQuery({
    queryKey,
    queryFn: () => fetchChatRunnerToken(chatKey),
    enabled: Boolean(chatKey),
    staleTime: STALE_TIME_MS,
  });

  const ensureFresh =
    useCallback(async (): Promise<ChatRunnerCredentials | null> => {
      if (!chatKey) {
        return null;
      }
      const cached =
        queryClient.getQueryData<ChatRunnerTokenResponse>(queryKey);
      if (cached) {
        const expiresAtMs = Date.parse(cached.expiresAt);
        const remainingMs = expiresAtMs - Date.now();
        if (
          Number.isFinite(expiresAtMs) &&
          remainingMs > REFRESH_THRESHOLD_MS
        ) {
          return { token: cached.token, apiBaseUrl: cached.apiBaseUrl };
        }
      }
      // Force a network fetch: passing staleTime: 0 tells fetchQuery to
      // ignore any still-fresh cache entry (in particular the case where the
      // cached token has <10m to live but the TanStack Query staleTime has
      // not yet elapsed).
      try {
        const fresh = await queryClient.fetchQuery({
          queryKey,
          queryFn: () => fetchChatRunnerToken(chatKey),
          staleTime: 0,
        });
        return { token: fresh.token, apiBaseUrl: fresh.apiBaseUrl };
      } catch {
        return null;
      }
    }, [chatKey, queryClient, queryKey]);

  return {
    ...query,
    token: query.data?.token,
    apiBaseUrl: query.data?.apiBaseUrl,
    expiresAt: query.data?.expiresAt,
    ensureFresh,
  };
}
