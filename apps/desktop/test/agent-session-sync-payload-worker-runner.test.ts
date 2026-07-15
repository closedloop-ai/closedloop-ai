import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";
import type { Worker } from "node:worker_threads";
import type { PreparedAgentSessionPayload } from "../src/main/agent-session-sync-payload.js";
import { createAgentSessionPayloadWorkerPreparer } from "../src/main/agent-session-sync-payload-worker-runner.js";

const WORKER_FAILURE_RE = /boom/;
const WORKER_ERROR_RE = /worker exploded/;
const WORKER_EXIT_RE = /agent-session payload worker exited 3/;
const WORKER_DISPOSED_RE = /agent-session payload worker disposed/;

type WorkerListener = (arg: never) => void;

// Minimal controllable stand-in for a node:worker_threads Worker. It records
// postMessage/terminate/unref and lets a test drive the message/error/exit
// events the runner subscribes to via `on`.
class FakePayloadWorker {
  readonly postMessage = mock.fn((_message: unknown) => {
    // no-op: the runner only fires messages at us; it never reads a return.
  });
  readonly unref = mock.fn(() => this);
  readonly terminate = mock.fn(() => Promise.resolve(0));
  private readonly listeners = new Map<string, WorkerListener[]>();

  on(event: string, listener: WorkerListener): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (value: unknown) => void)(arg);
    }
  }

  lastRequestId(): string {
    const call = this.postMessage.mock.calls.at(-1);
    if (!call) {
      throw new Error("expected a postMessage call before reading requestId");
    }
    return (call.arguments[0] as { requestId: string }).requestId;
  }
}

function createPreparerWithFakeWorkers() {
  const workers: FakePayloadWorker[] = [];
  const createWorker = mock.fn((): Worker => {
    const fake = new FakePayloadWorker();
    workers.push(fake);
    return fake as unknown as Worker;
  });
  const preparer = createAgentSessionPayloadWorkerPreparer(createWorker);
  return { preparer, createWorker, workers };
}

// Fire-and-forget a prepare call whose promise is intentionally left pending
// (the test only cares about the worker-lifecycle side effects).
function ignorePending(promise: Promise<unknown>): void {
  promise.catch(() => {
    // swallow: these requests are never settled by the test.
  });
}

afterEach(() => {
  mock.restoreAll();
});

describe("createAgentSessionPayloadWorkerPreparer", () => {
  test("does not create a worker until the first prepare call, then reuses it", () => {
    const { preparer, createWorker } = createPreparerWithFakeWorkers();
    assert.strictEqual(
      createWorker.mock.calls.length,
      0,
      "worker is created lazily, not at construction"
    );

    ignorePending(preparer([], 1000));
    ignorePending(preparer([], 1000));

    assert.strictEqual(
      createWorker.mock.calls.length,
      1,
      "a single worker is reused across prepare calls"
    );
  });

  test("dispatches the request and resolves the pending promise by requestId", async () => {
    const { preparer, workers } = createPreparerWithFakeWorkers();
    const payloads: PreparedAgentSessionPayload[] = [];

    const pending = preparer([], 2048);
    const worker = workers[0];
    const message = worker.postMessage.mock.calls[0]?.arguments[0] as {
      requestId: string;
      maxBytes: number;
    };
    assert.strictEqual(typeof message.requestId, "string");
    assert.strictEqual(message.maxBytes, 2048);
    // FEA-2718 retired the syncMode option (its only consumer, the fragment
    // builder, was removed), so the worker message must NOT carry it.
    assert.strictEqual(
      (message as { syncMode?: unknown }).syncMode,
      undefined,
      "the retired syncMode option is not forwarded to the worker"
    );

    worker.emit("message", {
      requestId: worker.lastRequestId(),
      ok: true,
      payloads,
    });

    assert.strictEqual(await pending, payloads);
  });

  test("rejects the pending promise when the worker reports failure", async () => {
    const { preparer, workers } = createPreparerWithFakeWorkers();
    const pending = preparer([], 1000);
    const worker = workers[0];

    worker.emit("message", {
      requestId: worker.lastRequestId(),
      ok: false,
      error: "boom",
    });

    await assert.rejects(pending, WORKER_FAILURE_RE);
  });

  test("ignores messages for an unknown requestId, leaving pending requests intact", async () => {
    const { preparer, workers } = createPreparerWithFakeWorkers();
    const pending = preparer([], 1000);
    const worker = workers[0];
    const realRequestId = worker.lastRequestId();

    // A stray message for an id we never issued must be a silent no-op.
    assert.doesNotThrow(() =>
      worker.emit("message", {
        requestId: "not-a-real-request-id",
        ok: true,
        payloads: [],
      })
    );

    // The genuine request still resolves normally afterward.
    const payloads: PreparedAgentSessionPayload[] = [];
    worker.emit("message", { requestId: realRequestId, ok: true, payloads });
    assert.strictEqual(await pending, payloads);
  });

  test("worker error rejects all pending requests and recreates the worker on the next call", async () => {
    const { preparer, createWorker, workers } = createPreparerWithFakeWorkers();
    const first = preparer([], 1000);
    const second = preparer([], 1000);
    const worker = workers[0];

    worker.emit("error", new Error("worker exploded"));

    await assert.rejects(first, WORKER_ERROR_RE);
    await assert.rejects(second, WORKER_ERROR_RE);

    ignorePending(preparer([], 1000));
    assert.strictEqual(
      createWorker.mock.calls.length,
      2,
      "the nulled worker is recreated on the next prepare call"
    );
  });

  test("non-zero worker exit rejects all pending requests", async () => {
    const { preparer, workers } = createPreparerWithFakeWorkers();
    const pending = preparer([], 1000);
    const worker = workers[0];

    worker.emit("exit", 3);

    await assert.rejects(pending, WORKER_EXIT_RE);
  });

  test("clean (zero-code) worker exit does not reject, but recreates the worker next call", () => {
    const { preparer, createWorker, workers } = createPreparerWithFakeWorkers();
    ignorePending(preparer([], 1000));
    const worker = workers[0];

    worker.emit("exit", 0);

    ignorePending(preparer([], 1000));
    assert.strictEqual(
      createWorker.mock.calls.length,
      2,
      "a clean exit still nulls the worker so the next call recreates it"
    );
  });

  test("dispose rejects pending requests and terminates the worker", async () => {
    const { preparer, createWorker, workers } = createPreparerWithFakeWorkers();
    const pending = preparer([], 1000);
    const worker = workers[0];

    assert.ok(preparer.dispose, "preparer exposes dispose");
    await preparer.dispose();

    await assert.rejects(pending, WORKER_DISPOSED_RE);
    assert.strictEqual(worker.terminate.mock.calls.length, 1);

    // After dispose the worker is nulled, so the next call spins up a fresh one.
    ignorePending(preparer([], 1000));
    assert.strictEqual(createWorker.mock.calls.length, 2);
  });
});
