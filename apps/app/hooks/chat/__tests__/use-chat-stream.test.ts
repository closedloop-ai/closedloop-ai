import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useChatStream } from "../use-chat-stream";

function makeNdjsonResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

describe("useChatStream — structured error events", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("forwards structured upsert error to callbacks.onError with phase/code/boundProvider", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeNdjsonResponse([
        '{"type":"error","phase":"upsert","code":"PROVIDER_MISMATCH","boundProvider":"codex","message":"Chat is bound to codex"}',
        '{"type":"done"}',
      ])
    );

    const onError = vi.fn();
    const { result } = renderHook(() => useChatStream());

    await act(async () => {
      await result.current.sendMessage(
        "/api/chat",
        { prompt: "hi" },
        { onError }
      );
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({
      phase: "upsert",
      code: "PROVIDER_MISMATCH",
      boundProvider: "codex",
      message: "Chat is bound to codex",
      raw: {
        type: "error",
        phase: "upsert",
        code: "PROVIDER_MISMATCH",
        boundProvider: "codex",
        message: "Chat is bound to codex",
      },
    });

    await waitFor(() => {
      expect(result.current.error).toBe("Chat is bound to codex");
    });
  });

  test("forwards legacy string error as structured event with only message set", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeNdjsonResponse([
        '{"type":"error","error":"claude crashed"}',
        '{"type":"done"}',
      ])
    );

    const onError = vi.fn();
    const { result } = renderHook(() => useChatStream());

    await act(async () => {
      await result.current.sendMessage(
        "/api/chat",
        { prompt: "hi" },
        { onError }
      );
    });

    expect(onError).toHaveBeenCalledTimes(1);
    const arg = onError.mock.calls[0][0];
    expect(arg.message).toBe("claude crashed");
    expect(arg.phase).toBeUndefined();
    expect(arg.code).toBeUndefined();
    expect(arg.boundProvider).toBeUndefined();

    await waitFor(() => {
      expect(result.current.error).toBe("claude crashed");
    });
  });

  test("forwards terminal error with phase/code preserved and stops streaming", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeNdjsonResponse([
        '{"type":"error","terminal":true,"phase":"spawn","code":"CLAUDE_NOT_FOUND","message":"claude binary not found"}',
      ])
    );

    const onError = vi.fn();
    const { result } = renderHook(() => useChatStream());

    await act(async () => {
      await result.current.sendMessage(
        "/api/chat",
        { prompt: "hi" },
        { onError }
      );
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "spawn",
        code: "CLAUDE_NOT_FOUND",
        message: "claude binary not found",
      })
    );

    await waitFor(() => {
      expect(result.current.error).toBe("claude binary not found");
    });
    expect(result.current.isStreaming).toBe(false);
  });
});

describe("useChatStream — sendMessage SendMessageResult contract", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("returns {ok:true} when the stream completes normally", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeNdjsonResponse([
        '{"type":"text","content":"hello"}',
        '{"type":"done"}',
      ])
    );

    const { result } = renderHook(() => useChatStream());
    let sendResult: unknown;
    await act(async () => {
      sendResult = await result.current.sendMessage("/api/gateway/chat", {
        prompt: "hi",
      });
    });
    expect(sendResult).toEqual({ ok: true });
  });

  test("returns {ok:false, reason:'http'} on non-OK response and sets error", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("nope", { status: 500 })
    );

    const { result } = renderHook(() => useChatStream());
    let sendResult: unknown;
    await act(async () => {
      sendResult = await result.current.sendMessage("/api/gateway/chat", {
        prompt: "hi",
      });
    });
    expect(sendResult).toEqual({ ok: false, reason: "http" });
    await waitFor(() => {
      expect(result.current.error).toBe("Failed to send message");
    });
  });

  test("returns {ok:false, reason:'stream-read'} when response has no body reader", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
    } as unknown as Response);

    const { result } = renderHook(() => useChatStream());
    let sendResult: unknown;
    await act(async () => {
      sendResult = await result.current.sendMessage("/api/gateway/chat", {
        prompt: "hi",
      });
    });
    expect(sendResult).toEqual({ ok: false, reason: "stream-read" });
    await waitFor(() => {
      expect(result.current.error).toBe("No response body");
    });
  });

  test("returns {ok:false, reason:'transport'} when fetch throws a non-abort error", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TypeError("network down")
    );

    const { result } = renderHook(() => useChatStream());
    let sendResult: unknown;
    await act(async () => {
      sendResult = await result.current.sendMessage("/api/gateway/chat", {
        prompt: "hi",
      });
    });
    expect(sendResult).toEqual({ ok: false, reason: "transport" });
    await waitFor(() => {
      expect(result.current.error).toBe("network down");
    });
  });

  test("returns {ok:true} when fetch is aborted by the user", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new DOMException("aborted", "AbortError")
    );

    const { result } = renderHook(() => useChatStream());
    let sendResult: unknown;
    await act(async () => {
      sendResult = await result.current.sendMessage("/api/gateway/chat", {
        prompt: "hi",
      });
    });
    expect(sendResult).toEqual({ ok: true });
  });

  test("returns {ok:false, reason:'upsert'} when stream emits phase='upsert' error and still fires onError", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeNdjsonResponse([
        '{"type":"error","phase":"upsert","code":"BACKEND_ERROR","message":"upsert failed"}',
        '{"type":"done"}',
      ])
    );

    const onError = vi.fn();
    const { result } = renderHook(() => useChatStream());
    let sendResult: unknown;
    await act(async () => {
      sendResult = await result.current.sendMessage(
        "/api/gateway/chat",
        { prompt: "hi" },
        { onError }
      );
    });
    expect(sendResult).toEqual({ ok: false, reason: "upsert" });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "upsert", message: "upsert failed" })
    );
  });

  test("returns {ok:false, reason:'already-streaming'} when a second send arrives mid-stream", async () => {
    // Hold the first fetch pending so the second sendMessage call sees an
    // active stream. Without the drop-send fix, this branch would return
    // {ok: true} and useChatSession would clear selected PR context even
    // though the second message was never actually submitted.
    let resolveFirstFetch: (response: Response) => void = () => {};
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFirstFetch = resolve;
    });
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockReturnValueOnce(pendingFetch);

    const { result } = renderHook(() => useChatStream());

    // Kick off the first send without awaiting so the ref stays set.
    let firstSendPromise: Promise<unknown> = Promise.resolve();
    await act(async () => {
      firstSendPromise = result.current.sendMessage("/api/gateway/chat", {
        prompt: "first",
      });
      // Yield microtasks so sendMessage executes past the
      // isStreamingRef.current=true assignment before the second call.
      await Promise.resolve();
    });

    // Now issue a second send while the first is still pending on fetch.
    let secondResult: unknown;
    await act(async () => {
      secondResult = await result.current.sendMessage("/api/gateway/chat", {
        prompt: "second",
      });
    });

    expect(secondResult).toEqual({ ok: false, reason: "already-streaming" });
    // Only the first fetch should have been dispatched — the dropped send
    // must not have called fetch at all.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Resolve the first fetch so the hanging stream drains cleanly.
    resolveFirstFetch(makeNdjsonResponse(['{"type":"done"}']));
    await act(async () => {
      await firstSendPromise;
    });
  });
});
