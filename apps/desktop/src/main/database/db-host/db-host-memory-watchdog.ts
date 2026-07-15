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

export type MemoryPressureLevel = "ok" | "high";

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
    sample.heapUsed >= heapHigh || sample.rss >= rssHigh ? "high" : "ok";
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
 */
export function startHeapWatchdog(options: HeapWatchdogOptions): HeapWatchdog {
  const warn = options.warnHeapBytes ?? DEFAULT_WARN_HEAP_BYTES;
  const intervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const snapshotEnabled = process.env[HEAP_SNAPSHOT_ENV] === "1";
  let over = false;
  let snapshotWritten = false;

  const timer = setInterval(() => {
    const { heapUsed, rss } = process.memoryUsage();
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
      clearInterval(timer);
    },
  };
}

/**
 * Run a single op and log its heap delta when it allocates more than
 * `opDeltaWarnBytes` or leaves the heap above `warnHeapBytes`. This is the probe
 * that NAMES the leaking op in production logs. The measurement is cheap
 * (`process.memoryUsage()` before/after); it never changes the op's result or
 * error behavior — a throw propagates unchanged after logging.
 */
export async function measureOp<T>(
  label: string,
  log: Logger,
  run: () => Promise<T>,
  opts?: { opDeltaWarnBytes?: number; warnHeapBytes?: number }
): Promise<T> {
  const deltaWarn = opts?.opDeltaWarnBytes ?? DEFAULT_OP_DELTA_WARN_BYTES;
  const heapWarn = opts?.warnHeapBytes ?? DEFAULT_WARN_HEAP_BYTES;
  const before = process.memoryUsage().heapUsed;
  try {
    return await run();
  } finally {
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
