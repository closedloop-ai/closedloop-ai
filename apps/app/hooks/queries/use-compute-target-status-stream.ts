"use client";

import { useAuth } from "@repo/auth/client";
import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { resolveApiUrl } from "@/hooks/use-api-client";
import { computeTargetKeys } from "./use-compute-targets";

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 2000;

/** Read SSE body and invalidate the compute-targets cache on each data frame. */
async function readStatusStream(
  body: ReadableStream<Uint8Array>,
  queryClient: QueryClient,
  isCancelled: () => boolean
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done || isCancelled()) {
      return;
    }

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      if (part.startsWith("data:")) {
        queryClient.invalidateQueries({
          queryKey: computeTargetKeys.list(),
        });
        break;
      }
    }
  }
}

/** Open an authenticated SSE connection and read status events. */
async function openStatusStream(
  token: string | null,
  signal: AbortSignal,
  queryClient: QueryClient,
  isCancelled: () => boolean
): Promise<boolean> {
  const url = `${resolveApiUrl()}/compute-targets/status-stream`;
  const response = await fetch(url, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "text/event-stream",
    },
    signal,
  });

  if (!(response.ok && response.body)) {
    return false;
  }

  await readStatusStream(response.body, queryClient, isCancelled);
  return true;
}

/**
 * Opens an SSE connection to /compute-targets/status-stream and
 * invalidates the compute-targets list query whenever a target's
 * online state changes. Uses fetch (not EventSource) for Bearer auth.
 */
export function useComputeTargetStatusStream(enabled = true) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    let abortController: AbortController | null = null;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const isCancelled = () => cancelled;

    const scheduleReconnect = () => {
      if (cancelled) {
        return;
      }
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        return;
      }
      reconnectAttempts += 1;
      const delay = RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempts - 1);
      reconnectTimer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (cancelled) {
        return;
      }

      abortController = new AbortController();

      getToken()
        .then(async (token) => {
          if (cancelled) {
            return;
          }
          const ok = await openStatusStream(
            token,
            abortController!.signal,
            queryClient,
            isCancelled
          );
          if (ok) {
            // Stream connected and ended naturally — reset counter and reconnect
            reconnectAttempts = 0;
          }
          if (!cancelled) {
            scheduleReconnect();
          }
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") {
            return;
          }
          if (!cancelled) {
            scheduleReconnect();
          }
        });
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
    };
  }, [enabled, getToken, queryClient]);
}
