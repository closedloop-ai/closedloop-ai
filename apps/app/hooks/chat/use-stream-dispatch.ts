"use client";

import type { ChatStreamAction } from "@repo/app/chat/hooks/chat-stream-reducer";
import type { useAbortController } from "@repo/app/chat/hooks/use-abort-controller";
import { type Dispatch, useCallback, useRef } from "react";
import type {
  SendMessageResult,
  UseChatStreamCallbacks,
} from "./use-chat-stream";
import type { useStreamReader } from "./use-stream-reader";

const MAX_RECONNECT_ATTEMPTS = 10;

type UseStreamDispatchParams = {
  dispatch: Dispatch<ChatStreamAction>;
  abortController: ReturnType<typeof useAbortController>;
  streamReader: ReturnType<typeof useStreamReader>;
};

/**
 * Owns the outbound `fetch` that kicks off a chat stream, the reconnect
 * loop, and the `SendMessageResult` discriminated union produced for
 * callers. The guard ref prevents overlapping sends from the same hook
 * instance — a second concurrent caller resolves to `{ ok: true }`
 * without issuing another fetch.
 */
export function useStreamDispatch(params: UseStreamDispatchParams) {
  const { dispatch, abortController, streamReader } = params;
  const isStreamingRef = useRef(false);

  const sendMessage = useCallback(
    async (
      operationUrl: string,
      body: Record<string, unknown>,
      callbacks?: UseChatStreamCallbacks
    ): Promise<SendMessageResult> => {
      if (isStreamingRef.current) {
        // A second send arrived while a previous stream was still
        // running. Report non-success so callers (useChatSession in
        // particular) do NOT run success side effects like
        // onContextConsumed — the user's selected PR comment context
        // must stay intact since their message was never submitted.
        return { ok: false, reason: "already-streaming" };
      }

      dispatch({ type: "send/start", startedAt: new Date().toISOString() });
      isStreamingRef.current = true;
      streamReader.reset();

      const controller = abortController.create();

      const resolveResult = (): SendMessageResult =>
        streamReader.wasUpsertFailed()
          ? { ok: false, reason: "upsert" }
          : { ok: true };

      try {
        // No Authorization header is needed here. The fetch interceptor
        // (engineer-fetch-interceptor.ts) rewrites this URL to either:
        //   (a) http://localhost:PORT/api/gateway/chat — LocalElectron direct
        //       mode; the gateway only listens on localhost so no token is
        //       required.
        //   (b) /api/gateway-relay/chat — CloudRelay mode; Clerk session
        //       middleware at the Next.js edge authenticates the request
        //       before forwarding to the remote gateway.
        // Neither path requires an Authorization header on the outbound fetch.
        const response = await fetch(operationUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          dispatch({ type: "error/set", message: "Failed to send message" });
          return { ok: false, reason: "http" };
        }

        const reader = response.body?.getReader();
        if (!reader) {
          dispatch({ type: "error/set", message: "No response body" });
          return { ok: false, reason: "stream-read" };
        }

        let commandId = response.headers.get("x-relay-command-id") ?? undefined;
        let result = await streamReader.readStream(reader, callbacks);

        commandId ??= result.commandId;
        let lastSeq = result.lastSeq;

        if (result.completed) {
          streamReader.emitLearningsUsed(callbacks);
          await callbacks?.onComplete?.(streamReader.getLatestText());
          return resolveResult();
        }

        if (result.terminalError) {
          return resolveResult();
        }

        if (commandId) {
          let attempts = 0;
          while (
            attempts < MAX_RECONNECT_ATTEMPTS &&
            !controller.signal.aborted
          ) {
            attempts++;

            // Exponential backoff: 1s, 2s, 4s, ... capped at 30s
            const delay = Math.min(1000 * 2 ** (attempts - 1), 30_000);
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, delay);
              controller.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true }
              );
            });
            if (controller.signal.aborted) {
              break;
            }

            console.log(
              `[chat-stream] Reconnect attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS}`
            );

            try {
              const reconnectHeaders: Record<string, string> = {
                "Content-Type": "application/json",
                "x-relay-after-sequence": String(lastSeq ?? 0),
              };
              if (commandId) {
                reconnectHeaders["x-relay-command-id"] = commandId;
              }
              const reconnectResponse = await fetch(operationUrl, {
                method: "POST",
                headers: reconnectHeaders,
                body: JSON.stringify(body),
                signal: controller.signal,
              });

              if (!reconnectResponse.ok) {
                console.log(
                  `[chat-stream] Reconnect response: ${reconnectResponse.status}`
                );
                // 4xx = auth/client error, stop retrying; 5xx = transient, keep trying
                if (reconnectResponse.status < 500) {
                  break;
                }
                continue;
              }

              const reconnectReader = reconnectResponse.body?.getReader();
              if (!reconnectReader) {
                break;
              }

              const seqBeforeReconnect = lastSeq;
              result = await streamReader.readStream(
                reconnectReader,
                callbacks,
                { initialContent: streamReader.getLatestText() }
              );

              commandId ??= result.commandId;
              lastSeq = result.lastSeq ?? lastSeq;

              // A reconnect that advanced `lastSeq` delivered new events,
              // which proves the gateway command is still live and
              // streaming. Reset the budget so a long command over a flaky
              // connection (repeated relay timeouts, each followed by a
              // productive resume) is not abandoned after 10 cumulative
              // drops. Mirrors the sibling reconnecting streams, which reset
              // on a successful connect (use-loop-stream.ts `onConnected`,
              // use-compute-target-status-stream.ts `onOpen` →
              // `reconnectAttempts = 0`). Guarding on progress rather than a
              // bare successful connect avoids an infinite loop when reconnects
              // keep succeeding but deliver nothing new.
              if (
                result.lastSeq !== undefined &&
                (seqBeforeReconnect === undefined ||
                  result.lastSeq > seqBeforeReconnect)
              ) {
                attempts = 0;
              }

              if (result.completed) {
                dispatch({ type: "error/clear" });
                streamReader.emitLearningsUsed(callbacks);
                await callbacks?.onComplete?.(streamReader.getLatestText());
                return resolveResult();
              }

              if (result.terminalError) {
                return resolveResult();
              }
            } catch (err) {
              if (err instanceof DOMException && err.name === "AbortError") {
                throw err;
              }
              console.error("[chat-stream] Reconnect error:", err);
              break;
            }
          }
        }

        if (controller.signal.aborted) {
          return { ok: true };
        }

        // Reconnect exhausted — surface error (chat has no poll fallback)
        if (!result.completed) {
          dispatch({
            type: "error/set",
            message:
              result.lastRelayError ??
              "Stream connection lost. Please try again.",
          });
          return { ok: false, reason: "stream-read" };
        }
        return resolveResult();
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // User stopped the stream — not an error
          return { ok: true };
        }
        console.error("Chat error:", err);
        dispatch({
          type: "error/set",
          message:
            err instanceof Error ? err.message : "Failed to send message",
        });
        return { ok: false, reason: "transport" };
      } finally {
        dispatch({ type: "send/finish" });
        isStreamingRef.current = false;
        abortController.clear();
        streamReader.reset();
      }
    },
    [dispatch, abortController, streamReader]
  );

  return { sendMessage };
}
