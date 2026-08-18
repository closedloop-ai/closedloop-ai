import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { SyncedAgentSession } from "./agent-sync/agent-session-sync-contract.js";
import type {
  AgentSessionPayloadPreparer,
  PreparedAgentSessionPayload,
} from "./agent-sync/agent-session-sync-payload.js";

/**
 * FEA-4014: bound every worker round-trip. Payload preparation runs in a
 * `worker_threads` Worker, and the runner used to `postMessage` a request and
 * wait on an unbounded promise for the reply. If the worker hung (a pathological
 * session that never finishes serializing, a lost/dropped message that never
 * round-trips, a wedged event loop), the pending promise NEVER settled — it
 * neither resolved nor rejected. The sync service awaits this preparer inside
 * `syncOnce` while holding its `syncing` single-flight guard, so a hung prepare
 * pinned `syncing = true` forever: every subsequent 5-second tick early-returned,
 * the queue froze mid-backfill (observed as "hangs at 5/13, never completes"),
 * and no session past the stuck batch could advance OR dead-letter.
 *
 * A timeout converts that silent hang into a rejection. `preparePayloads` then
 * always settles, so `syncOnce`'s `finally` releases `syncing` and the next tick
 * retries the batch. A prepare throw is a bounded transport error in the service
 * (FEA-3364): a transient hang recovers on retry, and a session that keeps
 * timing out is dead-lettered after the service's consecutive-error budget, so
 * forward progress is guaranteed and no session silently blocks the queue.
 */
export const PAYLOAD_WORKER_REQUEST_TIMEOUT_MS = 30_000;

type PendingRequest = {
  resolve: (payloads: PreparedAgentSessionPayload[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PayloadWorkerResponse =
  | {
      requestId: string;
      ok: true;
      payloads: PreparedAgentSessionPayload[];
    }
  | {
      requestId: string;
      ok: false;
      error: string;
      // FEA-4014: the worker's error constructor name so a serialization
      // `TypeError` survives the boundary (see `reconstructWorkerError`). Optional
      // for version skew — an omitted value falls back to a plain `Error`.
      errorName?: string;
    };

export function createAgentSessionPayloadWorkerPreparer(
  createWorker: () => Worker = createDefaultPayloadWorker,
  requestTimeoutMs: number = PAYLOAD_WORKER_REQUEST_TIMEOUT_MS
): AgentSessionPayloadPreparer {
  let worker: Worker | null = null;
  const pending = new Map<string, PendingRequest>();

  const preparePayloads: AgentSessionPayloadPreparer = (
    sessions: SyncedAgentSession[],
    maxBytes: number,
    compress?: boolean,
    activityChunkingSupported?: boolean
  ) =>
    new Promise<PreparedAgentSessionPayload[]>((resolve, reject) => {
      const requestId = randomUUID();
      // FEA-4014: reject (never hang) if the worker never answers. A cleared
      // timer never fires; a fired timer removes its own pending entry so a
      // late worker reply for the same id is a harmless unknown-id no-op.
      const timer = setTimeout(() => {
        if (pending.delete(requestId)) {
          reject(
            new Error(
              `agent-session payload worker timed out after ${requestTimeoutMs}ms`
            )
          );
        }
        // A request timeout is the signature of a wedged worker event loop (the
        // failure this bound exists to catch). Leaving the worker installed
        // would hand `getWorker()` the SAME unresponsive instance on every retry
        // and every later batch, so instead of restoring progress the stall
        // becomes queue-wide dead-lettering. Terminate + null the worker (and
        // reject any siblings still stuck on it — they can never be answered by
        // a wedged loop) so the next preparation attempt spins up a fresh one.
        invalidateWorker(
          new Error(
            `agent-session payload worker terminated after a ${requestTimeoutMs}ms request timeout`
          )
        );
      }, requestTimeoutMs);
      timer.unref?.();
      pending.set(requestId, { resolve, reject, timer });
      try {
        getWorker().postMessage({
          requestId,
          sessions,
          maxBytes,
          compress: compress === true,
          activityChunkingSupported: activityChunkingSupported === true,
        });
      } catch (dispatchError) {
        // A synchronous failure spinning up or messaging the worker must settle
        // and clean up now, not linger in `pending` until the timeout fires.
        if (pending.delete(requestId)) {
          clearTimeout(timer);
          reject(
            dispatchError instanceof Error
              ? dispatchError
              : new Error(String(dispatchError))
          );
        }
      }
    });
  preparePayloads.dispose = async () => {
    rejectAll(new Error("agent-session payload worker disposed"));
    const currentWorker = worker;
    worker = null;
    await currentWorker?.terminate();
  };

  return preparePayloads;

  function getWorker(): Worker {
    if (worker) {
      return worker;
    }

    worker = createWorker();
    worker.unref();
    worker.on("message", handleMessage);
    worker.on("error", (error) => {
      rejectAll(error);
      worker = null;
    });
    worker.on("exit", (code) => {
      worker = null;
      if (code !== 0) {
        rejectAll(new Error(`agent-session payload worker exited ${code}`));
      }
    });
    return worker;
  }

  function handleMessage(message: PayloadWorkerResponse): void {
    const pendingRequest = pending.get(message.requestId);
    if (!pendingRequest) {
      return;
    }
    pending.delete(message.requestId);
    clearTimeout(pendingRequest.timer);
    if (message.ok) {
      pendingRequest.resolve(message.payloads);
      return;
    }
    pendingRequest.reject(
      reconstructWorkerError(message.error, message.errorName)
    );
  }

  function rejectAll(error: Error): void {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  // FEA-4014: drop the current worker so the next `getWorker()` recreates a
  // fresh one, and settle every request still bound to it. `worker` is nulled
  // BEFORE the async `terminate()` so a concurrent prepare cannot post to the
  // instance we are tearing down. Any siblings still pending were dispatched to
  // this same (wedged) worker, so they are rejected here rather than left to
  // each hit their own timeout.
  function invalidateWorker(error: Error): void {
    const currentWorker = worker;
    worker = null;
    rejectAll(error);
    // Fire-and-forget: we cannot await from this sync path, and a terminate on a
    // wedged/already-dead worker may reject — swallow it so it never surfaces as
    // an unhandled rejection.
    currentWorker?.terminate().catch(() => {
      // ignore: the worker is being discarded regardless of terminate outcome.
    });
  }
}

function createDefaultPayloadWorker(): Worker {
  return new Worker(
    new URL("./agent-session-sync-payload-worker.js", import.meta.url)
  );
}

// FEA-4014: rebuild an error thrown inside the worker on the main thread,
// preserving its constructor when the worker relayed one. A worker-side
// serialization failure surfaces as a `TypeError` (JSON.stringify circular /
// bigint during prep); the service's `isLocalSerializationError` classifies on
// `instanceof TypeError`, so a plain-Error rehydration would misclassify a
// deterministic local prep bug as a transient socket fault and hand it the
// retry budget instead of dead-lettering it immediately. Reconstruct the same
// type here so the classification is identical to a main-thread throw. Unknown
// or omitted names (version skew, or a non-Error throw) fall back to `Error`.
function reconstructWorkerError(message: string, errorName?: string): Error {
  if (errorName === "TypeError") {
    return new TypeError(message);
  }
  return new Error(message);
}
