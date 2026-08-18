/**
 * FEA-3072 — db-host heap-pressure instrumentation.
 *
 * The db-host utilityProcess recurrently dies with `exit code 5` (V8 OOM) even
 * though no single DB payload exceeds ~12 MB (measured: 426 MB DB, largest
 * session metadata 2 MB, largest per-session event.data 4 MB, worst 10-session
 * sync batch 12 MB). A 12 GB heap blowup from ≤12 MB objects is a code-level
 * runaway allocation, not data volume — but the process is killed by the kernel
 * before it can report WHERE the memory went, so every prior fix (FEA-2038,
 * FEA-3059, the 10 MB dead-letter cap, the 12 GB ceiling) has been a guess.
 *
 * This module makes the next OOM self-describing:
 *  - `installProcessCrashLogging` catches `uncaughtException` /
 *    `unhandledRejection` and logs them via the reverse channel BEFORE the
 *    process dies (utilityProcess stderr is easy to miss; the main-process log
 *    is where operators actually look).
 *  - `startHeapWatchdog` samples `process.memoryUsage()` on an interval and,
 *    once `heapUsed` crosses a warn threshold (default 80% of the REAL
 *    `heap_size_limit` V8 reports — see DEFAULT_WARN_HEAP_BYTES — so it fires
 *    while the process is still alive), logs a heap-space breakdown and, when
 *    explicitly opted in via
 *    `CLOSEDLOOP_DBHOST_HEAP_SNAPSHOT=1`, writes a one-shot `.heapsnapshot` next
 *    to the DB for offline analysis in Chrome DevTools.
 *  - `measureOp` wraps a single handled op and logs its heap delta when the op
 *    allocates more than `opDeltaWarnBytes` or leaves the heap above the warn
 *    threshold — this is what actually NAMES the leaking op (e.g.
 *    `dashboard.getInsights` vs a sync store-op) in production logs.
 *
 * The snapshot is opt-in because `v8.writeHeapSnapshot()` on a near-ceiling heap
 * itself allocates and can tip the process over; the lightweight sampling and
 * per-op logging are always on and cheap (`process.memoryUsage()` is a syscall,
 * not a heap walk).
 */

import os from "node:os";
import {
  getHeapSpaceStatistics,
  getHeapStatistics,
  writeHeapSnapshot,
} from "node:v8";
import {
  defaultProfilingClock,
  type ProfilingClock,
  type ProfilingDbOpRow,
  type ProfilingSink,
  readMonotonicMs,
} from "../../../shared/profiling.js";

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

/**
 * Default heap-used warn threshold: 80% of the heap limit V8 ACTUALLY enforces
 * in this process. The previous fixed 8 GiB default never fired: the
 * utilityProcess heap is capped at the ~4 GiB pointer-compression cage no
 * matter what `--max-old-space-size` asks for (measured on Electron 39:
 * heap_size_limit stays 4096 MiB even with the flag set), so `heapUsed` could
 * never reach the old warn line. Reading `heap_size_limit` at module load keys
 * the threshold to reality on every Electron/Node this runs under.
 *
 * (Postscript to the FEA-3072 narrative above: the recurring exit-code-5 crash
 * turned out to be native — leaked libsql connections from `transaction()`
 * churn, see patches/@libsql__client@0.17.3.patch — not a V8 heap OOM. This watchdog
 * stays for genuine JS-heap pressure, with a threshold that can now fire.)
 */
const DEFAULT_WARN_HEAP_BYTES = Math.floor(
  0.8 * getHeapStatistics().heap_size_limit
);
/** Default per-op allocation that is worth naming in the log. */
const DEFAULT_OP_DELTA_WARN_BYTES = 512 * MIB;
/** How often to sample the heap. */
const DEFAULT_SAMPLE_INTERVAL_MS = 2000;

// FEA-3132 (E3/E4/E1): RSS high-water for the memory-pressure signal. The audit's
// central correction is that the OOM's worst case (a WAL/reader-snapshot pinning
// the -wal into the OS page cache) is RSS/page-cache growth INVISIBLE to
// `heapUsed` — so the admission signal must key on `rss` vs the MACHINE, not just
// heapUsed vs the 12 GB heap ceiling. Default to the smaller of 10 GiB and 75% of
// total RAM, so it adapts down on smaller machines and never sits above a level
// that would let the OS OOM-kill us first.
const DEFAULT_RSS_HIGH_WATER_BYTES = Math.min(
  10 * GIB,
  Math.floor(0.75 * os.totalmem())
);

/** Opt-in env flag for the (expensive) heap snapshot. */
const HEAP_SNAPSHOT_ENV = "CLOSEDLOOP_DBHOST_HEAP_SNAPSHOT";

type Logger = (message: string) => void;

function mib(bytes: number): string {
  return `${Math.round(bytes / MIB)} MB`;
}

/**
 * ISS-4823 — the pressure levels the db-host publishes to the parent. A const
 * object (not a bare union) so the wire boundary can validate against the SAME
 * value set the producer emits: `isDbHostResponse` rejects a `memory-pressure`
 * message whose level is not one of these, which keeps a malformed publication
 * from evicting a valid cached sample.
 */
export const MemoryPressureLevel = {
  Ok: "ok",
  High: "high",
} as const;

export type MemoryPressureLevel =
  (typeof MemoryPressureLevel)[keyof typeof MemoryPressureLevel];

/** True when `value` is a level this build knows how to act on. */
export function isMemoryPressureLevel(
  value: unknown
): value is MemoryPressureLevel {
  return value === MemoryPressureLevel.Ok || value === MemoryPressureLevel.High;
}

export type MemoryPressure = {
  level: MemoryPressureLevel;
  heapUsed: number;
  rss: number;
};

/**
 * FEA-3132 (E3): the ACTUATING signal the watchdog was missing — a cheap,
 * synchronous read of current memory pressure that callers consult to defer or
 * throttle heavy work (vs the sampling loop, which only logs). "high" when
 * `heapUsed` is at/over the heap warn line OR `rss` is at/over the machine-
 * relative RSS high-water (the WAL/page-cache path heapUsed can't see). Pure:
 * pass an explicit `sample`/thresholds in tests; defaults read the live process.
 */
export function getMemoryPressure(
  sample: { heapUsed: number; rss: number } = process.memoryUsage(),
  // `warnHeapBytes` matches the module's established option name (see
  // HeapWatchdogOptions / measureOp); `rssHighWaterBytes` is the RSS analog for
  // the machine-relative page-cache high-water this signal added.
  opts?: { warnHeapBytes?: number; rssHighWaterBytes?: number }
): MemoryPressure {
  const heapHigh = opts?.warnHeapBytes ?? DEFAULT_WARN_HEAP_BYTES;
  const rssHigh = opts?.rssHighWaterBytes ?? DEFAULT_RSS_HIGH_WATER_BYTES;
  const level: MemoryPressureLevel =
    sample.heapUsed >= heapHigh || sample.rss >= rssHigh
      ? MemoryPressureLevel.High
      : MemoryPressureLevel.Ok;
  return { level, heapUsed: sample.heapUsed, rss: sample.rss };
}

/** Compact heap-space breakdown for the log (which space is filling up). */
function heapSpaceSummary(): string {
  try {
    return getHeapSpaceStatistics()
      .filter((space) => space.space_used_size > 16 * MIB)
      .map(
        (space) =>
          `${space.space_name}=${mib(space.space_used_size)}/${mib(
            space.space_size
          )}`
      )
      .join(" ");
  } catch {
    return "(heap-space stats unavailable)";
  }
}

/**
 * Install top-level crash logging so an OOM-adjacent throw / rejection is
 * reported to the main process before the worker exits.
 *
 * CRITICAL (FEA-3072 review): registering an `uncaughtException` /
 * `unhandledRejection` listener SUPPRESSES Node's default crash-on-uncaught
 * behavior. The DbHostClient supervisor relies on the child *exiting* to trigger
 * `handleExit` → `scheduleRestart`, so a listener that only logs would leave the
 * worker limping in an undefined state and never restart — weakening the exact
 * path this file exists to harden. So these handlers log and THEN exit non-zero,
 * preserving the crash→restart contract while adding the diagnostic line. (The
 * real exit-code-5 OOM is a hard V8 abort that never reaches these handlers.)
 * `exit` is injectable so tests can assert the exit without terminating the
 * runner.
 */
export function installProcessCrashLogging(
  log: Logger,
  // The default exit is deferred one tick (setImmediate): `log` posts over
  // parentPort IPC, which flushes on the next loop turn, whereas a synchronous
  // process.exit() would terminate first and drop the crash-moment diagnostic
  // line — the whole point of these handlers. One tick in an already-doomed
  // worker is harmless; the restart still fires. Tests inject a synchronous exit
  // to assert the call without deferring.
  exit: (code: number) => void = (code) => {
    setImmediate(() => process.exit(code));
  }
): void {
  process.on("uncaughtException", (error) => {
    log(
      `db-host uncaughtException: ${
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error)
      } | heap ${mib(process.memoryUsage().heapUsed)} | ${heapSpaceSummary()}`
    );
    exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log(
      `db-host unhandledRejection: ${
        reason instanceof Error
          ? `${reason.name}: ${reason.message}`
          : String(reason)
      } | heap ${mib(process.memoryUsage().heapUsed)}`
    );
    exit(1);
  });
}

export type HeapWatchdogOptions = {
  log: Logger;
  /** Directory to write an opt-in heap snapshot into (typically the DB dataDir). */
  snapshotDir?: string;
  warnHeapBytes?: number;
  sampleIntervalMs?: number;
  /**
   * ISS-4823: publish the ACTUATING memory-pressure level (the same
   * {@link getMemoryPressure} signal the heavy-op gate and the backfill yield
   * consume in this process) so a main-process consumer can act on it too. The
   * DATA_REVISION rebuild runs in the MAIN process and its adaptive write-pause
   * gate declares a db-host-pressure arm, but `getMemoryPressure()` reads THIS
   * worker's `process.memoryUsage()` — main cannot call it. This sampling loop is
   * already the process's pressure observer, so it is the natural publisher; the
   * worker forwards each report over the reverse channel.
   *
   * Reporting policy (deliberately not pure edge-triggered): fires on EVERY
   * sample while the level is `"high"`, and once on the falling edge back to
   * `"ok"`. A consumer therefore treats a `"high"` older than a few sample
   * intervals as stale rather than as live pressure, so a crashed or wedged
   * worker can never leave main throttling forever on a value nobody is
   * refreshing. While `"ok"` (the overwhelmingly common state) it is silent.
   */
  onPressureChange?: (level: MemoryPressureLevel) => void;
  /**
   * ISS-4823 — sampling seams, injectable ONLY so a test can drive the real
   * publisher deterministically (quiet tick, repeated high, falling edge, and
   * that no tick survives `stop()`) instead of asserting the loop from outside.
   * Production leaves all three at their process/global defaults.
   */
  readMemoryUsage?: () => { heapUsed: number; rss: number };
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
};

export type HeapWatchdog = {
  /** Stop sampling (e.g. on clean close). */
  stop(): void;
};

/** Log the heap-pressure line (rising edge of a warn-threshold crossing). */
function reportHeapPressure(
  log: Logger,
  heapUsed: number,
  rss: number,
  warn: number
): void {
  log(
    `db-host HEAP PRESSURE: heapUsed=${mib(heapUsed)} rss=${mib(
      rss
    )} (warn≥${mib(warn)}, ceiling ${mib(
      getHeapStatistics().heap_size_limit
    )}) | ${heapSpaceSummary()}`
  );
}

/** Best-effort one-shot heap snapshot; failures are logged, never thrown. */
function writeHeapSnapshotSafely(
  log: Logger,
  dir: string,
  heapUsed: number
): void {
  try {
    const path = `${dir}/db-host-${heapUsed}.heapsnapshot`;
    writeHeapSnapshot(path);
    log(`db-host wrote heap snapshot: ${path}`);
  } catch (error) {
    log(
      `db-host heap snapshot failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Sample the heap on an interval and log a pressure warning (once per crossing)
 * when `heapUsed` exceeds `warnHeapBytes`. Writes a one-shot heap snapshot only
 * when `CLOSEDLOOP_DBHOST_HEAP_SNAPSHOT=1`. Idempotent per crossing: it logs on
 * the rising edge and re-arms once the heap drops back below the threshold, so a
 * sustained-high heap doesn't spam the log.
 *
 * ISS-4823: when `onPressureChange` is supplied the same per-tick sample also
 * publishes the {@link getMemoryPressure} level (see that option's note for the
 * reporting policy and why it is not purely edge-triggered).
 */
export function startHeapWatchdog(options: HeapWatchdogOptions): HeapWatchdog {
  const warn = options.warnHeapBytes ?? DEFAULT_WARN_HEAP_BYTES;
  const intervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const snapshotEnabled = process.env[HEAP_SNAPSHOT_ENV] === "1";
  const readMemoryUsage =
    options.readMemoryUsage ?? (() => process.memoryUsage());
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  let over = false;
  let snapshotWritten = false;
  // ISS-4823: last level handed to `onPressureChange`, so the falling edge back
  // to "ok" is reported exactly once instead of on every subsequent quiet sample.
  let lastReportedPressure: MemoryPressureLevel = MemoryPressureLevel.Ok;

  const timer = setIntervalFn(() => {
    // ONE sample per tick, reused for the pressure report and the heap-warn
    // logging below (mirrors `measureOp`'s single-snapshot discipline).
    const { heapUsed, rss } = readMemoryUsage();
    // Evaluate pressure BEFORE the heap-warn early return: the level is "high"
    // on `heapUsed` OR `rss`, and the RSS/page-cache arm (the WAL-pinning path
    // this signal exists for) can be high while `heapUsed` sits under `warn`.
    // Reading it after the early return would silently drop exactly that case.
    if (options.onPressureChange) {
      const { level } = getMemoryPressure(
        { heapUsed, rss },
        { warnHeapBytes: warn }
      );
      if (
        level === MemoryPressureLevel.High ||
        lastReportedPressure === MemoryPressureLevel.High
      ) {
        lastReportedPressure = level;
        options.onPressureChange(level);
      }
    }
    if (heapUsed < warn) {
      over = false;
      return;
    }
    if (over) {
      return;
    }
    over = true;
    reportHeapPressure(options.log, heapUsed, rss, warn);
    if (snapshotEnabled && !snapshotWritten && options.snapshotDir) {
      snapshotWritten = true;
      writeHeapSnapshotSafely(options.log, options.snapshotDir, heapUsed);
    }
  }, intervalMs);
  // Don't keep the event loop alive solely for sampling.
  timer.unref?.();

  return {
    stop(): void {
      clearIntervalFn(timer);
    },
  };
}

/**
 * Run a single op and log its heap delta when it allocates more than
 * `opDeltaWarnBytes` or leaves the heap above `warnHeapBytes`. This is the probe
 * that NAMES the leaking op in production logs. The measurement is cheap
 * (`process.memoryUsage()` before/after); it never changes the op's result or
 * error behavior — a throw propagates unchanged after logging.
 *
 * ISS-4430: when `opts.profiling` is supplied (only while
 * `CLOSEDLOOP_PROFILE_DIR` is set) the same wrapper also records the op's WALL
 * time. It is the one place every db-host op already funnels through, so a
 * parallel wrapper would be both redundant and less complete. The wall-time
 * capture is strictly additive: it reads the clock around the existing call,
 * records inside the SAME `finally` (so a throwing op is timed and still
 * rethrows), and swallows any sink/clock failure.
 */
export async function measureOp<T>(
  label: string,
  log: Logger,
  run: () => Promise<T>,
  opts?: MeasureOpOptions
): Promise<T> {
  const deltaWarn = opts?.opDeltaWarnBytes ?? DEFAULT_OP_DELTA_WARN_BYTES;
  const heapWarn = opts?.warnHeapBytes ?? DEFAULT_WARN_HEAP_BYTES;
  const profiling = opts?.profiling;
  const clock = profiling?.clock ?? defaultProfilingClock;
  // `null` both when profiling is off and when the clock itself failed, so the
  // record step below has exactly one "no usable start stamp" condition.
  const startedAt = profiling ? readMonotonicMs(clock) : null;
  const before = process.memoryUsage().heapUsed;
  try {
    return await run();
  } finally {
    // Record wall time BEFORE the heap snapshot so the duration reflects the op
    // rather than the op plus this probe's own `memoryUsage()` call.
    if (profiling && startedAt !== null) {
      recordOpDuration(profiling, clock, label, startedAt);
    }
    // Single post-op snapshot reused for heapUsed + rss (review: avoid a 3rd
    // memoryUsage() call on the per-invoke hot path).
    const after = process.memoryUsage();
    const delta = after.heapUsed - before;
    if (delta >= deltaWarn || after.heapUsed >= heapWarn) {
      log(
        `db-host op "${label}" heap +${mib(delta)} → ${mib(
          after.heapUsed
        )} (rss ${mib(after.rss)})`
      );
    }
  }
}

/**
 * ISS-4430 — the wall-time capture {@link measureOp} performs when profiling is
 * on. Injected (sink + clock) rather than read from a module global so the
 * timing contract is testable with a controlled clock and a recording sink.
 */
export type MeasureOpProfiling = {
  sink: ProfilingSink<ProfilingDbOpRow>;
  clock?: ProfilingClock;
};

/** Options accepted by {@link measureOp}. */
export type MeasureOpOptions = {
  opDeltaWarnBytes?: number;
  warnHeapBytes?: number;
  /** Absent in production; present only under `CLOSEDLOOP_PROFILE_DIR`. */
  profiling?: MeasureOpProfiling;
};

function recordOpDuration(
  profiling: MeasureOpProfiling,
  clock: ProfilingClock,
  op: string,
  startedAt: number
): void {
  try {
    profiling.sink.append({
      op,
      ms: clock.nowMs() - startedAt,
      ts: clock.nowEpochMs(),
    });
  } catch {
    // Fail-open: instrumentation never affects the instrumented operation.
  }
}
