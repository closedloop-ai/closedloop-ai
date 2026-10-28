import { log } from "@repo/observability/log";
import {
  DOC_SYNC_CALLBACK_MAX_EDITORS,
  type DocSyncChangeCallback,
} from "@repo/realtime-contract/doc-sync-internal";
import { errorCode } from "../storage/error-code";

export const DOC_SYNC_CHANGE_CALLBACK_FAILED_EVENT =
  "doc_sync.change_callback_failed";
export const DOC_SYNC_CHANGE_CALLBACK_DROPPED_EVENT =
  "doc_sync.change_callback_dropped";

export const DEFAULT_MAX_PENDING_CALLBACKS = 1000;
export const DEFAULT_CALLBACK_RETRY_DELAYS_MS: readonly number[] = [
  1000, 4000, 16_000,
];
export const CHANGE_CALLBACK_CONCURRENCY = 4;

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_PAYLOAD_TOO_LARGE = 413;

/**
 * The API's answers a retry cannot change (PR #9147 review): a body it
 * refuses, and a document it does not have. A 401 is retried, since an STS
 * outage answers it, and so is a 5xx.
 */
export const TERMINAL_CALLBACK_HTTP_STATUSES: ReadonlySet<number> = new Set([
  HTTP_BAD_REQUEST,
  HTTP_NOT_FOUND,
  HTTP_PAYLOAD_TOO_LARGE,
]);

/** A refusal's HTTP status, or the code of what the send threw. */
export type ChangeCallbackSendResult =
  | { ok: true }
  | { ok: false; httpStatus?: number; code?: string };

export type SendChangeCallback = (
  callback: DocSyncChangeCallback
) => Promise<ChangeCallbackSendResult>;

export type ChangeCallbackQueue = {
  enqueue(callback: DocSyncChangeCallback): void;
  /**
   * For shutdown: sends everything pending at once, with no further retries,
   * and resolves when nothing is pending or in flight, or after `deadlineMs`.
   * What is still pending or in flight then is logged as dropped.
   */
  flush(deadlineMs: number): Promise<void>;
};

type Pending = {
  callback: DocSyncChangeCallback;
  attempts: number;
  /** Epoch milliseconds before which it is not sent: its retry delay. */
  readyAt: number;
  /**
   * Changes that came after `callback` was first sent. A sent callback is
   * never merged into, so each retry is the same body under the same
   * `callbackId` (PR #9147 review); this goes out once it settles.
   */
  successor?: DocSyncChangeCallback;
};

/**
 * PLN-2200 T-7.4. At most one pending entry per document: a newer callback
 * merges into an unsent one, or waits behind a sent one as its successor.
 * Delivery is FIFO with {@link CHANGE_CALLBACK_CONCURRENCY} sends in flight,
 * never two for one document. A failed send is retried after each of
 * `retryDelaysMs`, then logged; a status in
 * {@link TERMINAL_CALLBACK_HTTP_STATUSES} is logged at once. Past
 * `maxPending`, the oldest pending entry is dropped and logged.
 */
// lc-debt: in-memory queue loses callbacks on a crash; upgrade path: an outbox table in the doc-sync database drained by this queue
export function createChangeCallbackQueue({
  send,
  maxPending = DEFAULT_MAX_PENDING_CALLBACKS,
  retryDelaysMs = DEFAULT_CALLBACK_RETRY_DELAYS_MS,
  now = Date.now,
}: {
  send: SendChangeCallback;
  maxPending?: number;
  retryDelaysMs?: readonly number[];
  now?: () => number;
}): ChangeCallbackQueue {
  /** Insertion order is delivery order. */
  const pending = new Map<string, Pending>();
  const inFlight = new Set<string>();
  const idleWaiters = new Set<() => void>();
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let flushing = false;

  const dropOverflow = () => {
    for (const documentName of pending.keys()) {
      if (pending.size <= maxPending) {
        return;
      }
      pending.delete(documentName);
      log.error("Doc sync change callback dropped", {
        event: DOC_SYNC_CHANGE_CALLBACK_DROPPED_EVENT,
        documentName,
        maxPending,
      });
    }
  };

  const armWake = (at: number) => {
    clearTimeout(wakeTimer);
    wakeTimer = undefined;
    let earliest = Number.POSITIVE_INFINITY;
    for (const [documentName, item] of pending) {
      if (!inFlight.has(documentName) && item.readyAt > at) {
        earliest = Math.min(earliest, item.readyAt);
      }
    }
    if (Number.isFinite(earliest)) {
      wakeTimer = setTimeout(pump, earliest - at);
      wakeTimer.unref?.();
    }
  };

  const settleIdle = () => {
    if (pending.size > 0 || inFlight.size > 0) {
      return;
    }
    for (const resolve of idleWaiters) {
      resolve();
    }
    idleWaiters.clear();
  };

  const retries = (item: Pending, result: ChangeCallbackSendResult) =>
    !(
      result.ok ||
      flushing ||
      item.attempts > retryDelaysMs.length ||
      (result.httpStatus !== undefined &&
        TERMINAL_CALLBACK_HTTP_STATUSES.has(result.httpStatus))
    );

  /** `newer` is what was enqueued while `item` was in flight: never sent. */
  const retry = (
    documentName: string,
    item: Pending,
    newer: Pending | undefined
  ) => {
    item.readyAt = now() + (retryDelaysMs[item.attempts - 1] ?? 0);
    if (newer) {
      item.successor = mergeOptional(item.successor, newer.callback);
      pending.delete(documentName);
    }
    pending.set(documentName, item);
    dropOverflow();
  };

  const sendSuccessor = (
    documentName: string,
    item: Pending,
    newer: Pending | undefined
  ) => {
    if (item.successor === undefined) {
      return;
    }
    if (newer) {
      newer.callback = mergeCallbacks(item.successor, newer.callback);
      return;
    }
    pending.set(documentName, {
      callback: item.successor,
      attempts: 0,
      readyAt: 0,
    });
    dropOverflow();
  };

  const deliver = async (documentName: string, item: Pending) => {
    item.attempts += 1;
    const result = await sendSafely(send, item.callback);
    inFlight.delete(documentName);
    const newer = pending.get(documentName);
    if (retries(item, result)) {
      retry(documentName, item, newer);
    } else {
      if (!result.ok) {
        logFailure(documentName, item.attempts, result);
      }
      sendSuccessor(documentName, item, newer);
    }
    pump();
  };

  function pump(): void {
    const at = now();
    for (const [documentName, item] of pending) {
      if (inFlight.size >= CHANGE_CALLBACK_CONCURRENCY) {
        break;
      }
      if (inFlight.has(documentName) || item.readyAt > at) {
        continue;
      }
      pending.delete(documentName);
      inFlight.add(documentName);
      deliver(documentName, item).catch(() => undefined);
    }
    armWake(at);
    settleIdle();
  }

  return {
    enqueue(callback) {
      const { documentName } = callback;
      const older = pending.get(documentName);
      if (older === undefined) {
        pending.set(documentName, { callback, attempts: 0, readyAt: 0 });
        dropOverflow();
      } else if (older.attempts === 0) {
        older.callback = mergeCallbacks(older.callback, callback);
      } else {
        older.successor = mergeOptional(older.successor, callback);
      }
      pump();
    },
    async flush(deadlineMs) {
      flushing = true;
      for (const item of pending.values()) {
        item.readyAt = 0;
      }
      const idle = new Promise<void>((resolve) => {
        idleWaiters.add(resolve);
      });
      pump();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        idle,
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, deadlineMs);
        }),
      ]);
      clearTimeout(deadline);
      clearTimeout(wakeTimer);
      for (const documentName of new Set([...inFlight, ...pending.keys()])) {
        log.error("Doc sync change callback dropped at shutdown", {
          event: DOC_SYNC_CHANGE_CALLBACK_DROPPED_EVENT,
          documentName,
        });
      }
      pending.clear();
    },
  };
}

/**
 * `newer`'s id and mentions, with both callbacks' sources, editors and change
 * window. Only an unsent callback is merged into, so the id is never one the
 * API has seen.
 */
function mergeCallbacks(
  older: DocSyncChangeCallback,
  newer: DocSyncChangeCallback
): DocSyncChangeCallback {
  return {
    ...newer,
    sources: [...new Set([...older.sources, ...newer.sources])],
    editorUserIds: [
      ...new Set([...older.editorUserIds, ...newer.editorUserIds]),
    ].slice(0, DOC_SYNC_CALLBACK_MAX_EDITORS),
    firstChangedAt:
      Date.parse(older.firstChangedAt) <= Date.parse(newer.firstChangedAt)
        ? older.firstChangedAt
        : newer.firstChangedAt,
    lastChangedAt:
      Date.parse(older.lastChangedAt) > Date.parse(newer.lastChangedAt)
        ? older.lastChangedAt
        : newer.lastChangedAt,
  };
}

/**
 * At error, except a 404: a document deleted in the app while its callback
 * was pending is a race, not a fault, so it is logged at warn.
 */
function logFailure(
  documentName: string,
  attempts: number,
  result: Exclude<ChangeCallbackSendResult, { ok: true }>
): void {
  const fields = {
    event: DOC_SYNC_CHANGE_CALLBACK_FAILED_EVENT,
    documentName,
    attempts,
    ...(result.httpStatus === undefined
      ? {}
      : { httpStatus: result.httpStatus }),
    ...(result.code === undefined ? {} : { code: result.code }),
  };
  if (result.httpStatus === HTTP_NOT_FOUND) {
    log.warn("Doc sync change callback's document not found", fields);
  } else {
    log.error("Doc sync change callback failed", fields);
  }
}

function mergeOptional(
  older: DocSyncChangeCallback | undefined,
  newer: DocSyncChangeCallback
): DocSyncChangeCallback {
  return older === undefined ? newer : mergeCallbacks(older, newer);
}

async function sendSafely(
  send: SendChangeCallback,
  callback: DocSyncChangeCallback
): Promise<ChangeCallbackSendResult> {
  try {
    return await send(callback);
  } catch (error) {
    return { ok: false, code: errorCode(error) };
  }
}
