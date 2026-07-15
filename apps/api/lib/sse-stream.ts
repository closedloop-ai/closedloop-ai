import { log } from "@repo/observability/log";

const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000;
const DEFAULT_MAX_STREAM_DURATION_MS = 30 * 60 * 1000;

type SseStreamControls = {
  /** Enqueue an SSE data frame. */
  send: (data: Uint8Array) => void;
  /** Gracefully close the stream (idempotent). */
  close: () => void;
};

type SseStreamOptions = {
  keepaliveIntervalMs?: number;
  maxDurationMs?: number;
  /** Logged when max duration is reached. */
  logContext?: Record<string, unknown>;
  /** Called once during cleanup (after timers and subscriptions cleared). */
  onCleanup?: () => void;
};

/**
 * Create an SSE ReadableStream with built-in keepalive, max-duration, and
 * idempotent cleanup. Each route only provides its subscription logic.
 *
 * `onStart` receives `send` and `close` controls and must return an
 * unsubscribe function (sync or async). If the async version returns `null`,
 * the stream closes immediately.
 */
export function createSseStream(
  onStart: (
    controls: SseStreamControls
  ) => (() => void) | Promise<(() => void) | null>,
  options?: SseStreamOptions
): ReadableStream<Uint8Array> {
  const keepaliveMs =
    options?.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
  const maxDurationMs =
    options?.maxDurationMs ?? DEFAULT_MAX_STREAM_DURATION_MS;

  let unsubscribe: (() => void) | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  let cleaned = false;

  return new ReadableStream({
    start(controller) {
      const cleanup = () => {
        if (cleaned) {
          return;
        }
        cleaned = true;
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        if (maxDurationTimer) {
          clearTimeout(maxDurationTimer);
          maxDurationTimer = null;
        }
        options?.onCleanup?.();
      };

      const safeClose = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Stream already closed.
        }
      };

      const send = (data: Uint8Array) => {
        if (cleaned) {
          return;
        }
        try {
          controller.enqueue(data);
        } catch (error) {
          log.error("Failed writing to SSE stream", {
            ...options?.logContext,
            error,
          });
          safeClose();
        }
      };

      const result = onStart({ send, close: safeClose });

      const finishSetup = (unsub: (() => void) | null) => {
        if (!unsub || cleaned) {
          if (unsub) {
            unsub();
          }
          safeClose();
          return;
        }

        unsubscribe = unsub;

        keepaliveTimer = setInterval(() => {
          try {
            controller.enqueue(KEEPALIVE_BYTES);
          } catch {
            safeClose();
          }
        }, keepaliveMs);

        maxDurationTimer = setTimeout(() => {
          if (options?.logContext) {
            log.info("SSE max duration reached", options.logContext);
          }
          safeClose();
        }, maxDurationMs);
      };

      if (result instanceof Promise) {
        result.then(finishSetup).catch((error) => {
          log.error("SSE stream setup failed", {
            ...options?.logContext,
            error,
          });
          safeClose();
        });
      } else {
        finishSetup(result);
      }
    },
    cancel() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (maxDurationTimer) {
        clearTimeout(maxDurationTimer);
        maxDurationTimer = null;
      }
      if (!cleaned) {
        cleaned = true;
        options?.onCleanup?.();
      }
    },
  });
}

const KEEPALIVE_BYTES = new TextEncoder().encode(": keepalive\n\n");

export function encodeSseData(
  data: unknown,
  options?: { id?: string | number }
): Uint8Array {
  // When an `id` is provided, prepend an SSE `id:` field so the browser's
  // native EventSource remembers it and replays it as `Last-Event-ID` on
  // auto-reconnect. Omitting it preserves the plain `data:`-only framing.
  const idLine = options?.id === undefined ? "" : `id: ${options.id}\n`;
  return new TextEncoder().encode(`${idLine}data: ${JSON.stringify(data)}\n\n`);
}

export function createSseResponse(
  stream: ReadableStream<Uint8Array>
): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
