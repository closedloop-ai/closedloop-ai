import type { ChatStreamAction } from "@repo/app/chat/hooks/chat-stream-reducer";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ReadChatStreamResult } from "@/lib/chat/chat-utils";
import { useStreamDispatch } from "../use-stream-dispatch";

/**
 * Direct unit test of `useStreamDispatch`. The composed `useChatStream` tests
 * exercise this hook through the real sub-hooks; here we inject fake
 * `dispatch`, `abortController`, and `streamReader` ports so the send path and
 * each error/return branch is asserted in isolation — including which reducer
 * actions fire and which `SendMessageResult` reason is produced — without the
 * reconnect loop (a single non-relay response never sets a `commandId`).
 */

const OPERATION_URL = "/api/gateway/chat";

/** A minimal `ReadChatStreamResult` with per-case overrides. */
function makeReadResult(
  overrides: Partial<ReadChatStreamResult> = {}
): ReadChatStreamResult {
  return {
    accumulated: "",
    completed: false,
    terminalError: false,
    ...overrides,
  };
}

/**
 * Builds a fake `streamReader` (shape of `useStreamReader`'s return) plus a
 * fake `abortController` (shape of `useAbortController`'s return) and a spied
 * `dispatch`. `readStream` resolves to the supplied result; `wasUpsertFailed`
 * and `getLatestText` are configurable so the `resolveResult` branch and the
 * completion callback payload can be driven.
 */
function makeDeps(options: {
  readResult?: ReadChatStreamResult;
  readStreamImpl?: () => Promise<ReadChatStreamResult>;
  upsertFailed?: boolean;
  latestText?: string;
  controller?: AbortController;
}) {
  const controller = options.controller ?? new AbortController();
  const dispatch = vi.fn<(action: ChatStreamAction) => void>();
  const streamReader = {
    readStream:
      options.readStreamImpl ??
      vi.fn(() =>
        Promise.resolve(
          options.readResult ?? makeReadResult({ completed: true })
        )
      ),
    reset: vi.fn(),
    getLatestText: vi.fn(() => options.latestText ?? ""),
    wasUpsertFailed: vi.fn(() => options.upsertFailed ?? false),
    emitLearningsUsed: vi.fn(),
  };
  const abortController = {
    create: vi.fn(() => controller),
    abort: vi.fn(() => controller.abort()),
    clear: vi.fn(),
  };
  return { controller, dispatch, streamReader, abortController };
}

/** A one-line NDJSON response body so `response.body?.getReader()` is truthy. */
function makeStreamResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"type":"text"}\n'));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

function renderDispatch(deps: ReturnType<typeof makeDeps>) {
  return renderHook(() =>
    useStreamDispatch({
      dispatch: deps.dispatch,
      abortController: deps.abortController,
      streamReader: deps.streamReader,
    })
  );
}

describe("useStreamDispatch — send path", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("returns {ok:true} and fires send/start + send/finish when the stream completes", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(makeStreamResponse());
    const deps = makeDeps({
      readResult: makeReadResult({ completed: true }),
      latestText: "final text",
    });
    const onComplete = vi.fn();

    const { result } = renderDispatch(deps);

    let sendResult: unknown;
    await act(async () => {
      sendResult = await result.current.sendMessage(
        OPERATION_URL,
        { prompt: "hi" },
        { onComplete }
      );
    });

    expect(sendResult).toEqual({ ok: true });
    // Outbound fetch shape: POST with JSON body and the abort signal.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OPERATION_URL);
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(init.signal).toBe(deps.controller.signal);
    // Completion side effects ran.
    expect(deps.streamReader.emitLearningsUsed).toHaveBeenCalledWith({
      onComplete,
    });
    expect(onComplete).toHaveBeenCalledWith("final text");
    // Lifecycle reducer actions bookend the send.
    const actionTypes = deps.dispatch.mock.calls.map((c) => c[0].type);
    expect(actionTypes).toContain("send/start");
    expect(actionTypes).toContain("send/finish");
    // finally-block teardown always runs.
    expect(deps.abortController.clear).toHaveBeenCalledTimes(1);
    expect(deps.streamReader.reset).toHaveBeenCalled();
  });

  test("returns {ok:false, reason:'upsert'} when the reader flags an upsert failure on a completed stream", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeStreamResponse()
    );
    const deps = makeDeps({
      readResult: makeReadResult({ completed: true }),
      upsertFailed: true,
    });

    const { result } = renderDispatch(deps);

    let sendResult: unknown;
    await act(async () => {
      sendResult = await result.current.sendMessage(OPERATION_URL, {
        prompt: "hi",
      });
    });

    expect(sendResult).toEqual({ ok: false, reason: "upsert" });
  });

  test("returns {ok:true} on a terminal-error stream without an upsert failure", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeStreamResponse()
    );
    const deps = makeDeps({
      readResult: makeReadResult({ terminalError: true }),
    });

    const { result } = renderDispatch(deps);

    let sendResult: unknown;
    await act(async () => {
      sendResult = await result.current.sendMessage(OPERATION_URL, {
        prompt: "hi",
      });
    });

    // terminalError short-circuits to resolveResult(); no upsert failure -> ok.
    expect(sendResult).toEqual({ ok: true });
  });

  test("returns {ok:false, reason:'upsert'} when a terminal-error stream also failed its upsert", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeStreamResponse()
    );
    const deps = makeDeps({
      readResult: makeReadResult({ terminalError: true }),
      upsertFailed: true,
    });

    const { result } = renderDispatch(deps);

    let sendResult: unknown;
    await act(async () => {
      sendResult = await result.current.sendMessage(OPERATION_URL, {
        prompt: "hi",
      });
    });

    // terminalError routes through resolveResult(), which still consults
    // wasUpsertFailed() first — a terminal upsert error must surface as an
    // upsert failure, not a silent ok.
    expect(sendResult).toEqual({ ok: false, reason: "upsert" });
  });

  test("returns {ok:false, reason:'stream-read'} on a non-relay incomplete stream, skipping reconnect", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeStreamResponse()
    );
    const deps = makeDeps({
      // No commandId, not completed, not a terminal error: a single-shot
      // non-relay response that ended mid-stream. There is nothing to reconnect
      // to, so the reconnect loop is skipped entirely.
      readResult: makeReadResult({ completed: false, terminalError: false }),
    });

    const { result } = renderDispatch(deps);

    let sendResult: unknown;
    await act(async () => {
      sendResult = await result.current.sendMessage(OPERATION_URL, {
        prompt: "hi",
      });
    });

    // readStream ran exactly once — the missing commandId skipped reconnect,
    // so this never silently succeeded or started retrying.
    expect(deps.streamReader.readStream).toHaveBeenCalledTimes(1);
    expect(sendResult).toEqual({ ok: false, reason: "stream-read" });
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "error/set",
      message: "Stream connection lost. Please try again.",
    });
  });

  test("returns {ok:false, reason:'already-streaming'} for a concurrent second send without a second fetch", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(makeStreamResponse());
    // The first send parks inside readStream until we release it, keeping the
    // isStreamingRef guard set while the second send arrives.
    let releaseRead: (r: ReadChatStreamResult) => void = () => {
      /* set below */
    };
    const deps = makeDeps({
      readStreamImpl: () =>
        new Promise<ReadChatStreamResult>((resolve) => {
          releaseRead = resolve;
        }),
    });

    const { result } = renderDispatch(deps);

    let firstResult: unknown;
    let secondResult: unknown;
    await act(async () => {
      const first = result.current.sendMessage(OPERATION_URL, { prompt: "a" });
      // Let the first send reach readStream and set the guard.
      await Promise.resolve();
      secondResult = await result.current.sendMessage(OPERATION_URL, {
        prompt: "b",
      });
      releaseRead(makeReadResult({ completed: true }));
      firstResult = await first;
    });

    expect(secondResult).toEqual({ ok: false, reason: "already-streaming" });
    expect(firstResult).toEqual({ ok: true });
    // The blocked second send never issued its own fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("releases the streaming guard after a send settles so a later send issues its own fetch", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    // A fresh Response per call — its ReadableStream body is single-use, so
    // reusing one object would lock the body on the second getReader().
    fetchMock.mockImplementation(() => Promise.resolve(makeStreamResponse()));
    const deps = makeDeps({
      readResult: makeReadResult({ completed: true }),
    });

    const { result } = renderDispatch(deps);

    let firstResult: unknown;
    await act(async () => {
      firstResult = await result.current.sendMessage(OPERATION_URL, {
        prompt: "a",
      });
    });

    expect(firstResult).toEqual({ ok: true });
    // The finally block's `isStreamingRef.current = false` teardown ran, so the
    // guard is clear. Without that reset, a later send would short-circuit to
    // `already-streaming` and never fetch — this asserts the opposite.
    let laterResult: unknown;
    await act(async () => {
      laterResult = await result.current.sendMessage(OPERATION_URL, {
        prompt: "b",
      });
    });

    expect(laterResult).toEqual({ ok: true });
    // Each settled send issued its own fetch — the guard did not stick.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("useStreamDispatch — error path", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("returns {ok:false, reason:'http'} and dispatches error/set on a non-OK response", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("nope", { status: 500 })
    );
    const deps = makeDeps({});

    const { result } = renderDispatch(deps);

    let sendResult: unknown;
    await act(async () => {
      sendResult = await result.current.sendMessage(OPERATION_URL, {
        prompt: "hi",
      });
    });

    expect(sendResult).toEqual({ ok: false, reason: "http" });
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "error/set",
      message: "Failed to send message",
    });
    // readStream is never reached on an HTTP failure.
    expect(deps.streamReader.readStream).not.toHaveBeenCalled();
  });

  test("returns {ok:false, reason:'stream-read'} when the OK response has no body reader", async () => {
    // An OK response with a null body: `response.body` is null, so
    // `response.body?.getReader()` is undefined and there is no reader.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(null, { status: 200 })
    );
    const deps = makeDeps({});

    const { result } = renderDispatch(deps);

    let sendResult: unknown;
    await act(async () => {
      sendResult = await result.current.sendMessage(OPERATION_URL, {
        prompt: "hi",
      });
    });

    expect(sendResult).toEqual({ ok: false, reason: "stream-read" });
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "error/set",
      message: "No response body",
    });
  });

  test("returns {ok:false, reason:'transport'} and surfaces the error message when fetch rejects", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("network down")
    );
    const deps = makeDeps({});

    const { result } = renderDispatch(deps);

    let sendResult: unknown;
    await act(async () => {
      sendResult = await result.current.sendMessage(OPERATION_URL, {
        prompt: "hi",
      });
    });

    expect(sendResult).toEqual({ ok: false, reason: "transport" });
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "error/set",
      message: "network down",
    });
    // Even on a thrown transport error the finally block tears down.
    expect(deps.abortController.clear).toHaveBeenCalledTimes(1);
    expect(deps.dispatch.mock.calls.map((c) => c[0].type)).toContain(
      "send/finish"
    );
  });

  test("returns {ok:true} without an error dispatch when fetch is aborted by the user", async () => {
    const abortError = new DOMException("aborted", "AbortError");
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      abortError
    );
    const deps = makeDeps({});

    const { result } = renderDispatch(deps);

    let sendResult: unknown;
    await act(async () => {
      sendResult = await result.current.sendMessage(OPERATION_URL, {
        prompt: "hi",
      });
    });

    // A user abort is success, not an error — no error/set dispatched.
    expect(sendResult).toEqual({ ok: true });
    const errorSets = deps.dispatch.mock.calls.filter(
      (c) => c[0].type === "error/set"
    );
    expect(errorSets).toHaveLength(0);
  });
});
