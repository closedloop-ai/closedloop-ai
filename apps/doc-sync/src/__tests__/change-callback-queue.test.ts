import { log } from "@repo/observability/log";
import {
  type DocSyncChangeCallback,
  DocSyncChangeSource,
} from "@repo/realtime-contract/doc-sync-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHANGE_CALLBACK_CONCURRENCY,
  type ChangeCallbackSendResult,
  createChangeCallbackQueue,
  DOC_SYNC_CHANGE_CALLBACK_DROPPED_EVENT,
  DOC_SYNC_CHANGE_CALLBACK_FAILED_EVENT,
} from "../callbacks/change-callback-queue";

const RETRY_DELAYS_MS = [1000, 4000, 16_000];
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_SERVICE_UNAVAILABLE = 503;

function callback(
  documentName: string,
  overrides: Partial<DocSyncChangeCallback> = {}
): DocSyncChangeCallback {
  return {
    callbackId: crypto.randomUUID(),
    documentName,
    sources: [DocSyncChangeSource.Connection],
    editorUserIds: [],
    firstChangedAt: "2026-10-22T10:00:00.000Z",
    lastChangedAt: "2026-10-22T10:00:00.000Z",
    mentions: [],
    mentionsTruncated: false,
    ...overrides,
  };
}

type Call = {
  callback: DocSyncChangeCallback;
  settle: (result: ChangeCallbackSendResult) => void;
};

/** A `send` whose every call waits until the test settles it. */
function heldSend() {
  const calls: Call[] = [];
  const send = vi.fn(
    (sent: DocSyncChangeCallback) =>
      new Promise<ChangeCallbackSendResult>((settle) => {
        calls.push({ callback: sent, settle });
      })
  );
  return { send, calls };
}

const OK: ChangeCallbackSendResult = { ok: true };
const REFUSED: ChangeCallbackSendResult = {
  ok: false,
  httpStatus: HTTP_SERVICE_UNAVAILABLE,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createChangeCallbackQueue", () => {
  it("merges a newer callback into the document's pending one", async () => {
    const { send, calls } = heldSend();
    const queue = createChangeCallbackQueue({ send });
    for (let index = 0; index < CHANGE_CALLBACK_CONCURRENCY; index++) {
      queue.enqueue(callback(`busy-${index}`));
    }
    // Every send slot is taken, so these two wait and merge.
    queue.enqueue(
      callback("later", {
        sources: [DocSyncChangeSource.Clear],
        editorUserIds: ["user-a"],
        firstChangedAt: "2026-10-22T10:00:01.000Z",
        lastChangedAt: "2026-10-22T10:00:02.000Z",
      })
    );
    const newer = callback("later", {
      sources: [DocSyncChangeSource.Connection],
      editorUserIds: ["user-b"],
      firstChangedAt: "2026-10-22T10:00:05.000Z",
      lastChangedAt: "2026-10-22T10:00:06.000Z",
    });
    queue.enqueue(newer);
    expect(send).toHaveBeenCalledTimes(CHANGE_CALLBACK_CONCURRENCY);

    calls[0]?.settle(OK);
    await vi.advanceTimersByTimeAsync(0);

    expect(send).toHaveBeenCalledTimes(CHANGE_CALLBACK_CONCURRENCY + 1);
    expect(calls.at(-1)?.callback).toEqual({
      ...newer,
      sources: [DocSyncChangeSource.Clear, DocSyncChangeSource.Connection],
      editorUserIds: ["user-a", "user-b"],
      firstChangedAt: "2026-10-22T10:00:01.000Z",
    });
  });

  it("retries a failed send after its delay, then stops on success", async () => {
    const { send, calls } = heldSend();
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const queue = createChangeCallbackQueue({
      send,
      retryDelaysMs: RETRY_DELAYS_MS,
    });
    const sent = callback("doc");
    queue.enqueue(sent);

    calls[0]?.settle(REFUSED);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] - 1);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(calls[1]?.callback.callbackId).toBe(sent.callbackId);

    calls[1]?.settle(OK);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
  });

  it("logs the failure once every retry is spent", async () => {
    const send = vi.fn(() => Promise.resolve(REFUSED));
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const queue = createChangeCallbackQueue({
      send,
      retryDelaysMs: RETRY_DELAYS_MS,
    });

    queue.enqueue(callback("doc"));
    await vi.advanceTimersByTimeAsync(
      RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)
    );

    expect(send).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.any(String), {
      event: DOC_SYNC_CHANGE_CALLBACK_FAILED_EVENT,
      documentName: "doc",
      attempts: RETRY_DELAYS_MS.length + 1,
      httpStatus: HTTP_SERVICE_UNAVAILABLE,
    });
  });

  it("resends a failed callback unchanged, under its id, after its delay, and sends what came during it next", async () => {
    const { send, calls } = heldSend();
    vi.spyOn(log, "error").mockImplementation(() => undefined);
    const queue = createChangeCallbackQueue({
      send,
      retryDelaysMs: RETRY_DELAYS_MS,
    });
    const first = callback("doc", { editorUserIds: ["user-a"] });
    queue.enqueue(first);
    const during = callback("doc", { editorUserIds: ["user-b"] });
    queue.enqueue(during);

    calls[0]?.settle(REFUSED);
    await vi.advanceTimersByTimeAsync(0);
    queue.enqueue(callback("doc", { editorUserIds: ["user-c"] }));
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] - 1);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls[1]?.callback).toEqual(first);

    calls[1]?.settle(OK);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[2]?.callback).toMatchObject({
      editorUserIds: ["user-b", "user-c"],
    });
    expect(calls[2]?.callback.callbackId).not.toBe(first.callbackId);
  });

  it("keeps a retrying callback's attempts while newer ones arrive, so a busy document still logs the failure", async () => {
    const send = vi.fn(() => Promise.resolve(REFUSED));
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const queue = createChangeCallbackQueue({
      send,
      retryDelaysMs: RETRY_DELAYS_MS,
    });

    queue.enqueue(callback("doc"));
    for (const delay of RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      queue.enqueue(callback("doc"));
      await vi.advanceTimersByTimeAsync(1);
    }

    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: DOC_SYNC_CHANGE_CALLBACK_FAILED_EVENT,
        attempts: RETRY_DELAYS_MS.length + 1,
      })
    );
  });

  it.each([
    [HTTP_BAD_REQUEST, "error"],
    [HTTP_PAYLOAD_TOO_LARGE, "error"],
    [HTTP_NOT_FOUND, "warn"],
  ] as const)(
    "does not retry a %i, and logs it at %s",
    async (httpStatus, level) => {
      const send = vi.fn(() => Promise.resolve({ ok: false, httpStatus }));
      const logged = {
        error: vi.spyOn(log, "error").mockImplementation(() => undefined),
        warn: vi.spyOn(log, "warn").mockImplementation(() => undefined),
      };
      const queue = createChangeCallbackQueue({
        send,
        retryDelaysMs: RETRY_DELAYS_MS,
      });

      queue.enqueue(callback("doc"));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(send).toHaveBeenCalledTimes(1);
      expect(logged[level]).toHaveBeenCalledWith(expect.any(String), {
        event: DOC_SYNC_CHANGE_CALLBACK_FAILED_EVENT,
        documentName: "doc",
        attempts: 1,
        httpStatus,
      });
      expect(
        logged[level === "warn" ? "error" : "warn"]
      ).not.toHaveBeenCalled();
    }
  );

  it("retries a 401, which an STS outage answers", async () => {
    const send = vi.fn(() =>
      Promise.resolve({ ok: false, httpStatus: HTTP_UNAUTHORIZED })
    );
    vi.spyOn(log, "error").mockImplementation(() => undefined);
    const queue = createChangeCallbackQueue({
      send,
      retryDelaysMs: RETRY_DELAYS_MS,
    });

    queue.enqueue(callback("doc"));
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("drops the oldest pending callback past maxPending, and logs it", async () => {
    const { send, calls } = heldSend();
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const queue = createChangeCallbackQueue({ send, maxPending: 2 });
    for (let index = 0; index < CHANGE_CALLBACK_CONCURRENCY; index++) {
      queue.enqueue(callback(`busy-${index}`));
    }

    queue.enqueue(callback("oldest"));
    queue.enqueue(callback("middle"));
    queue.enqueue(callback("newest"));

    expect(error).toHaveBeenCalledWith(expect.any(String), {
      event: DOC_SYNC_CHANGE_CALLBACK_DROPPED_EVENT,
      documentName: "oldest",
      maxPending: 2,
    });
    for (const call of calls.splice(0)) {
      call.settle(OK);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((call) => call.callback.documentName)).toEqual([
      "middle",
      "newest",
    ]);
  });

  it("flush sends what waits on a retry at once, and at its deadline logs a hung send as dropped", async () => {
    const { send, calls } = heldSend();
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const queue = createChangeCallbackQueue({
      send,
      retryDelaysMs: RETRY_DELAYS_MS,
    });
    queue.enqueue(callback("doc"));
    calls[0]?.settle(REFUSED);
    await vi.advanceTimersByTimeAsync(0);
    let flushed = false;

    const flush = queue.flush(500).then(() => {
      flushed = true;
    });
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(flushed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush;

    expect(flushed).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.any(String), {
      event: DOC_SYNC_CHANGE_CALLBACK_DROPPED_EVENT,
      documentName: "doc",
    });
  });

  it("flush resolves as soon as nothing is pending or in flight", async () => {
    const { send, calls } = heldSend();
    const queue = createChangeCallbackQueue({ send });
    queue.enqueue(callback("doc"));
    let flushed = false;

    const flush = queue.flush(10_000).then(() => {
      flushed = true;
    });
    calls[0]?.settle(OK);
    await vi.advanceTimersByTimeAsync(0);
    await flush;

    expect(flushed).toBe(true);
  });
});
