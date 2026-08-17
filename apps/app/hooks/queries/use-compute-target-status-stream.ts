"use client";

import { useWaitForAuthLoaded } from "@repo/app/shared/auth/use-wait-for-auth-loaded";
import { useAuth } from "@repo/auth/client";
import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { resolveApiUrl } from "@/hooks/use-api-client";
import { computeTargetKeys } from "./compute-target-query-keys";

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY_MS = 2000;
// Cap the exponential backoff (2s, 4s, 8s, … capped at 30s) so a raised
// attempt budget doesn't balloon the delay. Mirrors the chat stream reconnect
// in use-stream-dispatch.ts.
const RECONNECT_MAX_DELAY_MS = 30_000;

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

// HTTP statuses that mean the current session can't authenticate to the
// stream. Reconnecting on these is pointless (the token won't recover on its
// own) and is the kind of tight loop that produced thousands of failed
// requests in FEA-3940 — so we stop entirely and let the app's degraded/re-auth
// surface take over instead of hammering the API.
const AUTH_FAILURE_STATUSES = new Set([401, 403]);

/**
 * Result of one stream attempt: `auth-failed` when the API rejected a request
 * that *did* carry a token (a genuinely bad session — stop reconnecting);
 * `disconnected` for any other clean end or transport failure, which is
 * eligible for a bounded reconnect. A 401/403 on a request sent with NO token
 * is also `disconnected`, not terminal: that's the transient token gap where
 * Clerk is loaded but `getToken()` briefly returned `null`/an about-to-rotate
 * token, so a bounded reconnect can recover once the token is available.
 */
type StreamAttemptResult = "auth-failed" | "disconnected";

/** Open an authenticated SSE connection and read status events. */
async function openStatusStream(
  token: string | null,
  signal: AbortSignal,
  queryClient: QueryClient,
  isCancelled: () => boolean,
  onOpen: () => void
): Promise<StreamAttemptResult> {
  const url = `${resolveApiUrl()}/compute-targets/status-stream`;
  const response = await fetch(url, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "text/event-stream",
    },
    signal,
  });

  if (AUTH_FAILURE_STATUSES.has(response.status)) {
    // Only latch as terminal when we actually presented a token and it was
    // still rejected. A rejection with no token is a transient acquisition gap
    // — reconnect (bounded) so the next `getToken()` can supply a valid token.
    return token ? "auth-failed" : "disconnected";
  }

  if (!(response.ok && response.body)) {
    return "disconnected";
  }

  // Connection established. Reset the reconnect budget now — not only on a
  // clean stream end — so a long-lived stream that later drops mid-read is
  // counted as a fresh failure rather than exhausting the budget for good.
  onOpen();

  await readStatusStream(response.body, queryClient, isCancelled);
  return "disconnected";
}

/**
 * Opens an SSE connection to /compute-targets/status-stream and
 * invalidates the compute-targets list query whenever a target's
 * online state changes. Uses fetch (not EventSource) for Bearer auth.
 */
export function useComputeTargetStatusStream(enabled = true) {
  const { getToken } = useAuth();
  const waitForAuthLoaded = useWaitForAuthLoaded();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    let abortController: AbortController | null = null;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // Latch set when the API rejects the session (401/403). Once set, we stop
    // reconnecting for the life of this effect: the token can't self-heal, so
    // retrying would just hammer the API (FEA-3940). Recovery comes from a
    // re-auth, which remounts this hook and clears the latch.
    let authFailed = false;

    const isCancelled = () => cancelled;

    const scheduleReconnect = () => {
      if (cancelled || authFailed) {
        return;
      }
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        return;
      }
      reconnectAttempts += 1;
      const delay = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempts - 1),
        RECONNECT_MAX_DELAY_MS
      );
      reconnectTimer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (cancelled) {
        return;
      }

      abortController = new AbortController();

      waitForAuthLoaded()
        .then(() => getToken())
        .then(async (token) => {
          if (cancelled) {
            return;
          }
          const result = await openStatusStream(
            token,
            abortController!.signal,
            queryClient,
            isCancelled,
            () => {
              // Reset the moment the connection opens so a brief relay/API
              // outage that drops a live stream mid-read doesn't exhaust the
              // reconnect budget and freeze the online indicator.
              reconnectAttempts = 0;
            }
          );
          if (result === "auth-failed") {
            // Session can't authenticate; stop reconnecting instead of looping.
            authFailed = true;
            return;
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
  }, [enabled, getToken, queryClient, waitForAuthLoaded]);
}
