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
