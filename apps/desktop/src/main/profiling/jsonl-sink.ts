/**
 * ISS-4430 — buffered JSONL sink for profiling rows.
 *
 * Instrumented call sites are hot (every db-host op, every IPC invoke), so a
 * synchronous write per row would itself distort the measurement. Rows are
 * buffered and appended in batches: on an interval, once the batch threshold is
 * reached, and on close.
 *
 * Writes are single-flight — only one `appendFile` is in flight at a time — so
 * batches can never interleave and corrupt a line. That means a slow or wedged
 * disk lets the buffer grow, which is exactly why it is bounded: past
 * {@link MAX_BUFFERED_ROWS} the OLDEST half is shed.
 *
 * Rows are lost two ways — shed at that ceiling, or lost with a write batch the
 * disk rejected — and BOTH feed one counter that `close` reports as a final
 * {@link PROFILING_DROPPED_ROWS_KEY} marker row. This matters more than it
 * looks: without it a transient disk failure leaves a partial population that
 * still yields confident-looking percentiles downstream, with nothing anywhere
 * saying the capture was lossy. The marker is what lets an analyzer tell "this
 * op never ran" apart from "this row was dropped" instead of reading a truncated
 * population as the truth.
 *
 * Every error is swallowed, the marker write included. This module has no
 * `electron` import so the db-host utilityProcess can use it.
 */

import { appendFile } from "node:fs/promises";
import {
  defaultProfilingClock,
  PROFILING_DROPPED_ROWS_KEY,
  type ProfilingClock,
  type ProfilingRow,
} from "../../shared/profiling.js";

/** Flush once the batch reaches this many rows. */
const FLUSH_ROW_THRESHOLD = 500;
/** Hard in-memory ceiling; past it the oldest half of the buffer is shed. */
const MAX_BUFFERED_ROWS = 10_000;
/** Periodic flush cadence, so a low-traffic run still lands rows on disk. */
const FLUSH_INTERVAL_MS = 2000;
/**
 * Upper bound on how long {@link JsonlSink.close} waits for the disk. Close runs
 * on the process quit path, where the app already has its own hard-exit
 * watchdog; a wedged write must lose rows rather than hold the quit open long
 * enough to turn a clean exit into a forced one.
 */
const CLOSE_DRAIN_TIMEOUT_MS = 2000;

export type JsonlSink = {
  /** Buffer one row. Never throws. */
  append(row: ProfilingRow): void;
  /** Start writing whatever is buffered. Does not wait for the write. */
  flush(): void;
  /** Flush, write the drop marker if any, and wait (bounded) for the disk. */
  close(): Promise<void>;
};

export type JsonlSinkOptions = {
  clock?: ProfilingClock;
  /** Test seams; production uses the module defaults. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  flushIntervalMs?: number;
  closeTimeoutMs?: number;
  /**
   * Test seam for the write itself, so the batch-loss accounting can be driven
   * with a writer that fails on demand. Making a real `appendFile` fail for
   * SOME batches and succeed for others requires mutating the filesystem
   * mid-flight and betting on when the rejection lands; this makes the
   * behavior under test exact instead of timing-dependent.
   */
  appendFn?: (filePath: string, chunk: string) => Promise<void>;
};

/**
 * Create a sink appending newline-delimited JSON to `filePath`. The file is
 * created on the first flush; the caller is responsible for the directory
 * existing (a missing directory simply makes every write fail, silently, which
 * is the intended fail-open behavior for instrumentation).
 */
export function createJsonlSink(
  filePath: string,
  options?: JsonlSinkOptions
): JsonlSink {
  const clock = options?.clock ?? defaultProfilingClock;
  const setIntervalFn = options?.setIntervalFn ?? setInterval;
  const clearIntervalFn = options?.clearIntervalFn ?? clearInterval;
  const closeTimeoutMs = options?.closeTimeoutMs ?? CLOSE_DRAIN_TIMEOUT_MS;
  const appendFn =
    options?.appendFn ??
    ((target: string, chunk: string) => appendFile(target, chunk, "utf8"));

  let buffered: string[] = [];
  let droppedRows = 0;
  let inFlight: Promise<void> | null = null;
  let closed = false;

  const flush = (): void => {
    if (inFlight || buffered.length === 0) {
      return;
    }
    const batchRows = buffered.length;
    const chunk = `${buffered.join("\n")}\n`;
    buffered = [];
    try {
      const write = appendFn(filePath, chunk)
        .catch(() => {
          // Fail-open: a profiling write must never surface to the app. But the
          // rows in this batch are GONE, and a silently-vanished batch would
          // leave the analyzer computing confident percentiles over a population
          // it has no idea is incomplete. Count them into the same loss counter
          // the buffer-ceiling shed uses, so `close` reports one honest total.
          droppedRows += batchRows;
        })
        .then(() => {
          if (inFlight === write) {
            inFlight = null;
          }
        });
      inFlight = write;
    } catch {
      // A writer that throws SYNCHRONOUSLY never produced a promise to attach
      // the counter to, and `flush` runs on an interval — an escaping throw
      // there would take the process down. Count the batch and carry on.
      droppedRows += batchRows;
    }
  };

  const timer = setIntervalFn(
    flush,
    options?.flushIntervalMs ?? FLUSH_INTERVAL_MS
  );
  timer.unref?.();

  return {
    append(row: ProfilingRow): void {
      if (closed) {
        return;
      }
      try {
        if (buffered.length >= MAX_BUFFERED_ROWS) {
          // Shed in one batch rather than one row per append: a per-append
          // `shift()` is O(n) on the hot path once the ceiling is reached.
          const shed = Math.floor(MAX_BUFFERED_ROWS / 2);
          buffered.splice(0, shed);
          droppedRows += shed;
        }
        buffered.push(JSON.stringify(row));
        if (buffered.length >= FLUSH_ROW_THRESHOLD) {
          flush();
        }
      } catch {
        // A row that cannot be serialized is dropped, not thrown at the caller.
      }
    },
    flush,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      clearIntervalFn(timer);
      await withTimeout(drainThenMarkLoss(), closeTimeoutMs);
    },
  };

  async function drain(): Promise<void> {
    // `append` is closed off by now, so the buffer can only shrink and this
    // terminates. Each iteration either awaits the in-flight write or starts
    // the next batch.
    while (inFlight || buffered.length > 0) {
      if (inFlight) {
        await inFlight;
        continue;
      }
      flush();
    }
  }

  /**
   * Drain the data rows, THEN write the loss marker. Composing the marker after
   * the drain rather than before it is what makes the count honest: a batch that
   * fails during this very drain still lands in the total. (If the marker's own
   * write fails there is nothing further to report — the count is already zeroed
   * and the loss is simply unrecorded, which is the fail-open floor.)
   */
  async function drainThenMarkLoss(): Promise<void> {
    await drain();
    if (droppedRows === 0) {
      return;
    }
    buffered.push(
      JSON.stringify({
        [PROFILING_DROPPED_ROWS_KEY]: droppedRows,
        ts: readEpochMs(clock),
      })
    );
    droppedRows = 0;
    await drain();
  }
}

function readEpochMs(clock: ProfilingClock): number {
  try {
    return clock.nowEpochMs();
  } catch {
    return 0;
  }
}

/** Resolve when `work` settles or the bound elapses, whichever is first. */
async function withTimeout(
  work: Promise<void>,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([work, bound]);
  } catch {
    // `work` already swallows its own failures; this guards a rejection from a
    // stubbed writer in tests so close() still resolves.
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
