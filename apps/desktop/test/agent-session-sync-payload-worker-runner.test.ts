import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { Worker } from "node:worker_threads";
import { vi } from "vitest";
import {
  createAgentSessionPayloadWorkerPreparer,
  PAYLOAD_WORKER_REQUEST_TIMEOUT_MS,
} from "../src/main/agent-session-sync-payload-worker-runner.js";
import type { PreparedAgentSessionPayload } from "../src/main/agent-sync/agent-session-sync-payload.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

const WORKER_FAILURE_RE = /boom/;
const WORKER_ERROR_RE = /worker exploded/;
const WORKER_EXIT_RE = /agent-session payload worker exited 3/;
const WORKER_DISPOSED_RE = /agent-session payload worker disposed/;
const WORKER_TIMEOUT_RE = /agent-session payload worker timed out/;
const WORKER_TERMINATED_RE = /terminated after a 30000ms request timeout/;
const WORKER_DISPATCH_RE = /postMessage exploded/;
const WORKER_CIRCULAR_RE = /circular structure/;

type WorkerListener = (arg: never) => void;

// Minimal controllable stand-in for a node:worker_threads Worker. It records
// postMessage/terminate/unref and lets a test drive the message/error/exit
// events the runner subscribes to via `on`.
class FakePayloadWorker {
  readonly postMessage = vi.fn((_message: unknown) => {
    // no-op: the runner only fires messages at us; it never reads a return.
  });
  readonly unref = vi.fn(() => this);
  readonly terminate = vi.fn(() => Promise.resolve(0));
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
    return (call[0] as { requestId: string }).requestId;
  }
}

function createPreparerWithFakeWorkers(requestTimeoutMs?: number) {
  const workers: FakePayloadWorker[] = [];
  const createWorker = vi.fn((): Worker => {
    const fake = new FakePayloadWorker();
    workers.push(fake);
    return fake as unknown as Worker;
  });
  const preparer = createAgentSessionPayloadWorkerPreparer(
    createWorker,
    requestTimeoutMs
  );
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
  vi.restoreAllMocks();
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
    const message = worker.postMessage.mock.calls[0]?.[0] as {
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

  test("FEA-4014: reconstructs a worker TypeError so serialization failures classify as local", async () => {
    // The worker relays only error text + name across the boundary. A worker-side
    // serialization failure (circular/bigint from JSON.stringify in prep) is a
    // TypeError; the service's `isLocalSerializationError` classifies on
    // `instanceof TypeError` to dead-letter it immediately. If the runner rebuilt
    // every worker error as a plain Error, that deterministic bug would be
    // misclassified as a transient socket fault and earn the retry budget instead.
    const { preparer, workers } = createPreparerWithFakeWorkers();
    const pending = preparer([], 1000);
    const worker = workers[0];

    worker.emit("message", {
      requestId: worker.lastRequestId(),
      ok: false,
      error: "Converting circular structure to JSON",
      errorName: "TypeError",
    });

    const rejection = await pending.then(
      () => {
        throw new Error("expected the request to reject");
      },
      (error: unknown) => error
    );
    assert.ok(
      rejection instanceof TypeError,
      "a worker-reported TypeError is reconstructed as a TypeError, not a plain Error"
    );
    assert.match((rejection as Error).message, WORKER_CIRCULAR_RE);
  });

  test("FEA-4014: a worker error without a relayed name falls back to a plain Error", async () => {
    // Version-skew / non-Error throw: an omitted errorName must degrade to Error,
    // never crash the reconstruction.
    const { preparer, workers } = createPreparerWithFakeWorkers();
    const pending = preparer([], 1000);
    const worker = workers[0];

    worker.emit("message", {
      requestId: worker.lastRequestId(),
      ok: false,
      error: "socket hang up",
    });

    const rejection = await pending.then(
      () => {
        throw new Error("expected the request to reject");
      },
      (error: unknown) => error
    );
    assert.ok(
      rejection instanceof Error && !(rejection instanceof TypeError),
      "an unnamed worker error rehydrates as a plain Error"
    );
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

  test("FEA-4014: a worker that never answers rejects with a timeout instead of hanging forever", async () => {
    // Regression for the "hangs at 5/13, never completes" startup-sync stall: a
    // wedged worker used to leave the prepare promise pending forever, which
    // pinned the sync service's single-flight `syncing` guard and froze the
    // whole queue. The bounded per-request timeout must now settle it.
    nodeTestTimers.enable(["setTimeout"]);
    try {
      const { preparer, workers } = createPreparerWithFakeWorkers();
      const pending = preparer([], 1000);
      const worker = workers[0];
      // The request was dispatched but the fake worker deliberately emits no
      // reply — the classic hang.
      assert.strictEqual(worker.postMessage.mock.calls.length, 1);

      nodeTestTimers.tick(PAYLOAD_WORKER_REQUEST_TIMEOUT_MS);

      await assert.rejects(pending, WORKER_TIMEOUT_RE);
    } finally {
      nodeTestTimers.reset();
    }
  });

  test("FEA-4014: a request timeout terminates the wedged worker so the next call spins up a fresh one", async () => {
    // Regression: the timeout used to leave the (wedged) worker installed, so
    // getWorker() handed the SAME unresponsive instance to every retry and later
    // batch — turning a stall into queue-wide dead-lettering. The timeout must
    // now terminate + null the worker so the next prepare recreates it.
    nodeTestTimers.enable(["setTimeout"]);
    try {
      const { preparer, createWorker, workers } =
        createPreparerWithFakeWorkers();
      const pending = preparer([], 1000);
      const wedged = workers[0];
      assert.strictEqual(wedged.postMessage.mock.calls.length, 1);

      nodeTestTimers.tick(PAYLOAD_WORKER_REQUEST_TIMEOUT_MS);
      await assert.rejects(pending, WORKER_TIMEOUT_RE);
      assert.strictEqual(
        wedged.terminate.mock.calls.length,
        1,
        "the timed-out worker is terminated, not left installed"
      );

      // The next prepare must NOT reuse the wedged worker — it creates a fresh one.
      ignorePending(preparer([], 1000));
      assert.strictEqual(
        createWorker.mock.calls.length,
        2,
        "a fresh worker is created after a timeout invalidation"
      );
      assert.strictEqual(
        workers[1]?.postMessage.mock.calls.length,
        1,
        "the next request is dispatched to the fresh worker"
      );
    } finally {
      nodeTestTimers.reset();
    }
  });

  test("FEA-4014: a request timeout also rejects siblings still stuck on the wedged worker", async () => {
    // Two requests share the wedged worker; the first request's timeout fires and
    // invalidates the worker. The sibling can never be answered by a wedged loop,
    // so it is rejected now (with the terminate reason) instead of dangling until
    // its own timeout.
    nodeTestTimers.enable(["setTimeout"]);
    try {
      const { preparer, workers } = createPreparerWithFakeWorkers();
      const first = preparer([], 1000);
      const second = preparer([], 1000);
      assert.strictEqual(workers.length, 1, "both requests share one worker");

      nodeTestTimers.tick(PAYLOAD_WORKER_REQUEST_TIMEOUT_MS);

      await assert.rejects(first, WORKER_TIMEOUT_RE);
      await assert.rejects(second, WORKER_TERMINATED_RE);
    } finally {
      nodeTestTimers.reset();
    }
  });

  test("FEA-4014: cancels the request timer once the worker replies", async () => {
    // Observably prove the timer is cleared (not merely that a stale timer is a
    // harmless no-op): the reply resolves the request, and clearTimeout must be
    // called for the resolved request's timer. If the clearTimeout on the reply
    // path were removed this assertion fails.
    nodeTestTimers.enable(["setTimeout"]);
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const { preparer, workers } = createPreparerWithFakeWorkers(50);
      const pending = preparer([], 1000);
      const worker = workers[0];
      const payloads: PreparedAgentSessionPayload[] = [];

      assert.strictEqual(
        clearSpy.mock.calls.length,
        0,
        "no timer is cleared before the reply arrives"
      );
      worker.emit("message", {
        requestId: worker.lastRequestId(),
        ok: true,
        payloads,
      });
      assert.strictEqual(await pending, payloads);
      assert.strictEqual(
        clearSpy.mock.calls.length,
        1,
        "the resolved request's timeout timer is cleared on reply"
      );

      // And a subsequent tick past the (now-cleared) deadline is inert.
      assert.doesNotThrow(() => nodeTestTimers.tick(1000));
    } finally {
      clearSpy.mockRestore();
      nodeTestTimers.reset();
    }
  });

  test("FEA-4014: the injected timeout fires at exactly the injected deadline, not before", async () => {
    // Pin the deadline to the injected value: ticking one ms short must NOT
    // reject, and ticking the final ms MUST. This fails if the injected
    // requestTimeoutMs is ignored (e.g. the timer is hardcoded or removed).
    nodeTestTimers.enable(["setTimeout"]);
    try {
      const { preparer, workers } = createPreparerWithFakeWorkers(50);
      const pending = preparer([], 1000);
      assert.strictEqual(workers[0]?.postMessage.mock.calls.length, 1);

      // 49ms: still inside the window — the request is not yet rejected.
      nodeTestTimers.tick(49);
      let settledEarly = false;
      pending.then(
        () => {
          settledEarly = true;
        },
        () => {
          settledEarly = true;
        }
      );
      await Promise.resolve();
      assert.strictEqual(
        settledEarly,
        false,
        "the request is still pending one ms before the injected deadline"
      );

      // The final ms crosses the injected 50ms deadline — now it rejects.
      nodeTestTimers.tick(1);
      await assert.rejects(pending, WORKER_TIMEOUT_RE);
    } finally {
      nodeTestTimers.reset();
    }
  });

  test("FEA-4014: a synchronous dispatch failure rejects immediately and leaves no lingering pending entry", async () => {
    // If spinning up or messaging the worker throws synchronously, the request
    // must settle now (not hang until the timeout) AND its pending/timer state
    // must be cleaned up so a later timeout callback cannot fire on it.
    nodeTestTimers.enable(["setTimeout"]);
    try {
      const workers: FakePayloadWorker[] = [];
      const createWorker = vi.fn((): Worker => {
        const fake = new FakePayloadWorker();
        fake.postMessage.mockImplementation(() => {
          throw new Error("postMessage exploded");
        });
        workers.push(fake);
        return fake as unknown as Worker;
      });
      const preparer = createAgentSessionPayloadWorkerPreparer(createWorker);

      const pending = preparer([], 1000);
      await assert.rejects(pending, WORKER_DISPATCH_RE);

      // The pending entry was removed, so advancing past any deadline is a no-op
      // (an un-cleaned entry would throw an unhandled rejection here).
      assert.doesNotThrow(() =>
        nodeTestTimers.tick(PAYLOAD_WORKER_REQUEST_TIMEOUT_MS)
      );
    } finally {
      nodeTestTimers.reset();
    }
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
