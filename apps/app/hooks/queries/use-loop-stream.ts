"use client";

import type { LoopEvent } from "@repo/api/src/types/loop";
import { useAuth } from "@repo/auth/client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveApiUrl } from "@/hooks/use-api-client";
import { loopKeys } from "./use-loops";

export type StreamStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

const TERMINAL_EVENT_TYPES = new Set(["completed", "error", "cancelled"]);

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
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  const [events, setEvents] = useState<LoopEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>("disconnected");
  const [lastEvent, setLastEvent] = useState<LoopEvent | null>(null);
  const [isComplete, setIsComplete] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

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

    if (!(enabled && loopId)) {
      setStatus("disconnected");
      return;
    }

    // Reset state when connecting to a new loop
    setEvents([]);
    setLastEvent(null);
    setIsComplete(false);
    setStatus("connecting");

    const controller = new AbortController();
    abortRef.current = controller;

    const capturedLoopId = loopId;

    const callbacks: StreamCallbacks = {
      isMounted: () => mountedRef.current,
      onConnected: () => {
        if (mountedRef.current) {
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
        if (mountedRef.current) {
          setStatus("disconnected");
        }
      },
      onError: () => {
        if (mountedRef.current) {
          setStatus("error");
        }
      },
    };

    getToken()
      .then((token) => {
        const url = `${resolveApiUrl()}/loops/${capturedLoopId}/stream`;
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
        if (mountedRef.current) {
          setStatus("error");
        }
      });

    return () => {
      mountedRef.current = false;
      disconnect();
    };
  }, [loopId, enabled, getToken, disconnect, invalidateLoopCache]);

  return { events, status, lastEvent, isComplete };
}
