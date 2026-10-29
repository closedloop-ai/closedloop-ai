/**
 * @file store-perf-sampler.ts
 * @description ISS-6339 — the cadence half of the desktop store performance
 * signal: drain the query-duration accumulator, read the on-disk size of the
 * store and its WAL sidecar, and hand both to the telemetry emit.
 *
 * ## Why it runs in the db-host
 *
 * The durations are accumulated at the adapter boundary, which only exists in
 * the db-host `utilityProcess`. Moving the numbers to main to emit them there
 * would mean a new clone-safe proxy method and a second cadence to keep in step,
 * for no gain: ISS-7109 already gave this process a telemetry relay, so an emit
 * from here reaches the same monitored transport main uses.
 *
 * ## Why the cadence is the store-integrity heartbeat
 *
 * {@link STORE_INTEGRITY_INTERVAL_MS_DEFAULT} is imported rather than restated
 * so the two periodic store signals cannot drift into different tempos, which
 * would make "the store was 4 GB when it got slow" an unanswerable question.
 *
 * ## Sizes are read, never inferred
 *
 * A `stat` that fails leaves the size UNKNOWN, and unknown is reported by
 * omitting the field — never as a zero. A zero would read as an empty store,
 * which is exactly the reassuring-but-false number this ticket exists to stop.
 * A missing `-wal` sidecar is the one exception: SQLite deletes it on a clean
 * close/checkpoint, so its absence is a genuine zero.
 */

import { stat } from "node:fs/promises";
import type { StorePerfDiagnostics } from "../../telemetry/telemetry-protocol.js";
import { STORE_INTEGRITY_INTERVAL_MS_DEFAULT } from "../database-integrity/store-integrity-probe.js";
import { isMissingFileError, WAL_SIDECAR_SUFFIX } from "../prisma-client.js";
import {
  QUERY_DURATION_BUCKET_BOUNDS_MS,
  type QueryPerfRecorder,
} from "./db-host-query-perf.js";

/** Sizes of the store on disk. A field is absent when its read did not resolve. */
export type StoreSizeSample = {
  dbSizeBytes?: number;
  walSizeBytes?: number;
};

export type StorePerfSampler = {
  /** Run one sample immediately (the cadence's own tick body). */
  sampleOnce(): Promise<StorePerfDiagnostics | null>;
  /**
   * ISS-7919: resolves once every tick this sampler has already STARTED has run
   * to completion — including the `stat` calls that finish on the libuv
   * threadpool, long after the interval callback itself returned.
   *
   * "The tick fired" and "the tick finished emitting" are different moments, and
   * only the second one is safe to read the emit sink after. Without this a
   * caller has to guess the gap, and a guess sized in milliseconds or event-loop
   * turns is wrong on a loaded host in the direction that matters: it reads the
   * sink too early and sees an absence that was really a not-yet.
   *
   * A stopped sampler starts nothing, so this resolves on the already-settled
   * tail and adds no wait — which is what makes it usable as the barrier for a
   * NON-occurrence assertion. Never rejects: a failing tick is logged, not
   * propagated, exactly as the cadence itself treats it.
   */
  whenSamplesSettled(): Promise<void>;
  stop(): void;
};

export type StorePerfSamplerOptions = {
  /** Absolute path of the SQLite store file. */
  databasePath: string;
  recorder: QueryPerfRecorder;
  /** Sink for each sample. Fire-and-forget; must not throw. */
  emit: (sample: StorePerfDiagnostics) => void;
  intervalMs?: number;
  log?: (message: string) => void;
};

/**
 * Read the store file and its WAL sidecar. Never throws: a size that cannot be
 * read is omitted, and the caller emits the rest of the sample rather than
 * losing the query histogram to a failed `stat`.
 */
export async function readStoreSizeSample(
  databasePath: string
): Promise<StoreSizeSample> {
  const [dbSizeBytes, walSizeBytes] = await Promise.all([
    fileSizeBytes(databasePath, false),
    fileSizeBytes(`${databasePath}${WAL_SIDECAR_SUFFIX}`, true),
  ]);
  const sample: StoreSizeSample = {};
  if (dbSizeBytes !== null) {
    sample.dbSizeBytes = dbSizeBytes;
  }
  if (walSizeBytes !== null) {
    sample.walSizeBytes = walSizeBytes;
  }
  return sample;
}

/**
 * Start the periodic sampler. The timer is unref'd so it can never hold the
 * db-host alive past a shutdown that is otherwise ready to exit.
 */
export function startStorePerfSampler(
  options: StorePerfSamplerOptions
): StorePerfSampler {
  const intervalMs = options.intervalMs ?? STORE_INTEGRITY_INTERVAL_MS_DEFAULT;
  const log = options.log ?? (() => undefined);

  async function sampleOnce(): Promise<StorePerfDiagnostics | null> {
    const queries = options.recorder.drain();
    // Nothing ran since the last drain. Emitting a zeroed sample here would let
    // an idle app and a broken accumulator produce the same event.
    if (queries === null) {
      return null;
    }
    const sizes = await readStoreSizeSample(options.databasePath);
    const sample: StorePerfDiagnostics = {
      windowMs: queries.windowMs,
      slowQueryThresholdMs: queries.slowQueryThresholdMs,
      // Sent with every sample rather than assumed by the consumer: a dashboard
      // reading `buckets` has no other way to know which bounds THIS build used,
      // and a silently-changed bound would redraw history wrong.
      bucketBoundsMs: [...QUERY_DURATION_BUCKET_BOUNDS_MS],
      families: queries.families,
      ...sizes,
    };
    options.emit(sample);
    return sample;
  }

  // The tail of every tick started so far. Reassigned rather than accumulated,
  // so it holds one promise however long the cadence runs — a settled tail is
  // dropped as soon as the next tick replaces it.
  let samplesSettled: Promise<unknown> = Promise.resolve();

  const timer = setInterval(() => {
    const tick = sampleOnce().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      log(`store perf sampler: sample failed (${detail})`);
    });
    samplesSettled = Promise.all([samplesSettled, tick]);
  }, intervalMs);
  timer.unref?.();

  return {
    sampleOnce,
    whenSamplesSettled(): Promise<void> {
      return samplesSettled.then(() => undefined);
    },
    stop(): void {
      clearInterval(timer);
    },
  };
}

/**
 * Size of one file in bytes, or `null` when it could not be read. `absentIsZero`
 * is true only for the WAL sidecar, whose absence genuinely means zero frames;
 * for every other path a missing file leaves the size unknown.
 */
async function fileSizeBytes(
  filePath: string,
  absentIsZero: boolean
): Promise<number | null> {
  try {
    const stats = await stat(filePath);
    return stats.size;
  } catch (error) {
    if (absentIsZero && isMissingFileError(error)) {
      return 0;
    }
    return null;
  }
}
