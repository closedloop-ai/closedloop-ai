"use client";

import type { LoopEvent } from "@repo/api/src/types/loop";
import { loopKeys } from "@repo/app/loops/hooks/loop-keys";
import { useApiAdapter } from "@repo/app/shared/api/provider";
import { useAuthSnapshot } from "@repo/app/shared/auth/use-auth-snapshot";
import { useWaitForAuthLoaded } from "@repo/app/shared/auth/use-wait-for-auth-loaded";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

export type StreamStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

const TERMINAL_EVENT_TYPES = new Set(["completed", "error", "cancelled"]);
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 2000;

/** Extract the data payload from a single SSE frame (between double newlines). */
function parseSSEFrame(frame: string): string {
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) {
      // Spec: "data:" followed by optional space then payload
      data += line.slice(line[5] === " " ? 6 : 5);
    }
  }
  return data;
}

/** Parse accumulated SSE frames from a raw buffer, returning parsed events and remaining buffer. */
function extractEventsFromBuffer(buffer: string): {
  events: LoopEvent[];
  remaining: string;
} {
  const parts = buffer.split("\n\n");
  const remaining = parts.pop() ?? "";
  const events: LoopEvent[] = [];

  for (const part of parts) {
    const data = parseSSEFrame(part);
    if (!data) {
      continue;
    }
    try {
      events.push(JSON.parse(data) as LoopEvent);
    } catch {
      // Skip malformed JSON lines
    }
  }

  return { events, remaining };
}

type StreamCallbacks = {
  onConnected: () => void;
  onEvents: (events: LoopEvent[]) => void;
  onTerminal: () => void;
  onStreamEnd: () => void;
  onError: () => void;
  isMounted: () => boolean;
};

/** Open an authenticated SSE connection and dispatch parsed events via callbacks. */
async function openSSEStream(
  url: string,
  token: string | null,
  signal: AbortSignal,
  callbacks: StreamCallbacks
): Promise<void> {
  const response = await fetch(url, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "text/event-stream",
    },
    signal,
  });

  if (!(response.ok && response.body)) {
    callbacks.onError();
    return;
  }

  callbacks.onConnected();
  await readSSEBody(response.body, callbacks);
}

/** Read and process the SSE response body stream chunk by chunk. */
async function readSSEBody(
  body: ReadableStream<Uint8Array>,
  callbacks: StreamCallbacks
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      callbacks.onStreamEnd();
      return;
    }

    buffer += decoder.decode(value, { stream: true });
    const { events, remaining } = extractEventsFromBuffer(buffer);
    buffer = remaining;

    if (!callbacks.isMounted()) {
      return;
    }

    const hasTerminal = events.some((e) => TERMINAL_EVENT_TYPES.has(e.type));

    callbacks.onEvents(events);

    if (hasTerminal) {
      callbacks.onTerminal();
      return;
    }
  }
}

/**
 * Connects to an SSE stream for a running loop, accumulating events in state.
 *
 * Uses fetch + ReadableStream (not EventSource) because the API requires
 * Bearer token auth and may be on a different origin. EventSource does not
 * support custom headers.
 *
 * Auto-disconnects when a terminal event (completed/error) is received and
 * invalidates the loop query cache so detail views refresh.
 */
export function useLoopStream(
  loopId: string | null,
  options?: { enabled?: boolean }
) {
  const { getToken } = useAuthSnapshot();
  const { resolveApiOrigin } = useApiAdapter();
  const waitForAuthLoaded = useWaitForAuthLoaded();
  const queryClient = useQueryClient();

  const [events, setEvents] = useState<LoopEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>("disconnected");
  const [lastEvent, setLastEvent] = useState<LoopEvent | null>(null);
  const [isComplete, setIsComplete] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const enabled = options?.enabled !== false && !!loopId;

  const disconnect = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const invalidateLoopCache = useCallback(
    (id: string) => {
      queryClient.invalidateQueries({ queryKey: loopKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: loopKeys.events(id) });
      queryClient.invalidateQueries({ queryKey: loopKeys.lists() });
    },
    [queryClient]
  );

  useEffect(() => {
    mountedRef.current = true;
    reconnectAttemptRef.current = 0;

    if (!(enabled && loopId)) {
      setStatus("disconnected");
      return;
    }

    // Reset state when connecting to a new loop
    setEvents([]);
    setLastEvent(null);
    setIsComplete(false);
    setStatus("connecting");

    const capturedLoopId = loopId;

    const connect = () => {
      if (!mountedRef.current) {
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setStatus("connecting");

      waitForAuthLoaded()
        .then(() => getToken())
        .then((token) => {
          const url = `${resolveApiOrigin()}/loops/${capturedLoopId}/stream`;
          return openSSEStream(url, token, controller.signal, callbacks);
        })
        .catch((err) => {
          // AbortError is expected on cleanup
          if (err instanceof DOMException && err.name === "AbortError") {
            if (mountedRef.current) {
              setStatus("disconnected");
            }
            return;
          }
          scheduleReconnect();
        });
    };

    const scheduleReconnect = () => {
      if (!mountedRef.current) {
        return;
      }
      const attempt = reconnectAttemptRef.current;
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        setStatus("error");
        return;
      }
      reconnectAttemptRef.current = attempt + 1;
      const delay = RECONNECT_BASE_DELAY_MS * 2 ** attempt;
      reconnectTimerRef.current = setTimeout(connect, delay);
    };

    const callbacks: StreamCallbacks = {
      isMounted: () => mountedRef.current,
      onConnected: () => {
        if (mountedRef.current) {
          reconnectAttemptRef.current = 0;
          setStatus("connected");
        }
      },
      onEvents: (newEvents) => {
        if (!mountedRef.current || newEvents.length === 0) {
          return;
        }
        setEvents((prev) => [...prev, ...newEvents]);
        setLastEvent(newEvents.at(-1) ?? null);
      },
      onTerminal: () => {
        if (mountedRef.current) {
          setIsComplete(true);
          setStatus("disconnected");
        }
        disconnect();
        invalidateLoopCache(capturedLoopId);
      },
      onStreamEnd: () => {
        // Stream ended without a terminal event — server may have closed
        // the connection early. Try to reconnect.
        scheduleReconnect();
      },
      onError: () => {
        scheduleReconnect();
      },
    };

    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      disconnect();
    };
  }, [
    loopId,
    enabled,
    getToken,
    disconnect,
    invalidateLoopCache,
    waitForAuthLoaded,
    resolveApiOrigin,
  ]);

  return { events, status, lastEvent, isComplete };
}
