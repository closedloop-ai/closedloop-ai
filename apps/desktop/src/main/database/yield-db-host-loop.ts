/**
 * @file yield-db-host-loop.ts
 * @description FEA-2264 shared cooperative-yield helper for the DB-host child.
 *
 * SQLite/libSQL runs synchronously on the DB host's single JS thread, which ALSO
 * serves the renderer's `desktop:db:*` reads. A long store op (the artifact-link
 * backfill, a full-corpus session hydration) that only ever awaits
 * microtask-resolved promises never returns control to libuv's poll phase, where
 * the parent process's queued IPC messages are delivered — so the dashboard
 * stays frozen until the op finishes. A `setImmediate` boundary reaches the
 * check phase and lets the loop service those queued reads BETWEEN units of
 * work, WITHOUT the real per-iteration sleep a main-side `cooperativeDelay`
 * applies (the backfill passes thousands of iterations, so a 50ms sleep each
 * would add minutes). Callers that thread this in as a `cooperativeDelay(ms)`
 * intentionally ignore the `ms` argument: the base `yieldDbHostLoop` yields, it
 * does not sleep.
 *
 * EXCEPTION (FEA-3132): `yieldDbHostLoopUnderMemoryPressure` below is the one
 * caller that DOES sleep — but only while `getMemoryPressure().level === "high"`.
 * At `ok` pressure it collapses to the plain sleep-free `yieldDbHostLoop`; under
 * pressure it deliberately real-sleeps in bounded ticks (PRESSURE_MAX_WAITS ×
 * PRESSURE_DELAY_MS) to let GC/WAL-checkpoint reclaim before the next chunk.
 */
import {
  getMemoryPressure,
  type MemoryPressure,
} from "./db-host/db-host-memory-watchdog.js";

export function yieldDbHostLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

// FEA-3132 (E3/E4/E1): bound on how long a single yield parks a backfill under
// sustained pressure. Each wait is one PRESSURE_DELAY_MS tick; PRESSURE_MAX_WAITS
// caps the total stall (~5s) so a genuinely stuck-high heap can't freeze the
// backfill forever — it proceeds, and the crash-storm restart backoff (FEA-3072)
// remains the backstop.
const PRESSURE_DELAY_MS = 100;
const PRESSURE_MAX_WAITS = 50;

/**
 * FEA-3132 (E3/E4): a MEMORY-AWARE cooperative yield for the heavy db-host
 * backfills. It actuates the watchdog signal the audit found was observe-only:
 * when the worker is under memory pressure (`getMemoryPressure().level === "high"`
 * — RSS/page-cache OR heap), it parks between units of work in short ticks so GC
 * runs, the WAL checkpoint can reclaim, and queued reads drain BEFORE the backfill
 * allocates its next chunk — throttling the backfill instead of dropping its work
 * (no caller retry needed). Not under pressure it collapses to the plain
 * `setImmediate` yield, so steady-state cost is unchanged. The stall is bounded
 * (PRESSURE_MAX_WAITS × PRESSURE_DELAY_MS); the loop always yields at least once
 * so reads are serviced even under pressure. `getPressure`/`delayMs`/`maxWaits`
 * are injectable for tests.
 *
 * When a `log` is supplied it emits a one-shot line the FIRST time it parks (so
 * a backfill that suddenly runs slow is self-describing as memory-pressure
 * parking — sitting next to the watchdog's own pressure logs — rather than an
 * unexplained stall) and again if it exhausts `maxWaits` and proceeds under
 * still-high pressure. Steady-state (no parking) stays silent.
 */
export async function yieldDbHostLoopUnderMemoryPressure(opts?: {
  getPressure?: () => MemoryPressure;
  delayMs?: number;
  maxWaits?: number;
  log?: (message: string) => void;
}): Promise<void> {
  const getPressure = opts?.getPressure ?? getMemoryPressure;
  const delayMs = opts?.delayMs ?? PRESSURE_DELAY_MS;
  const maxWaits = opts?.maxWaits ?? PRESSURE_MAX_WAITS;
  const log = opts?.log;
  let waits = 0;
  while (waits < maxWaits && getPressure().level === "high") {
    if (waits === 0) {
      log?.(
        `db-host backfill parking under memory pressure (up to ${maxWaits} × ${delayMs}ms)`
      );
    }
    waits += 1;
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }
  if (waits === maxWaits && getPressure().level === "high") {
    log?.(
      `db-host backfill proceeding after ${maxWaits} memory-pressure waits (still high)`
    );
  }
  await yieldDbHostLoop();
}

/**
 * FEA-3150 (FEA-3132 P1): a MEMORY-AWARE ADMISSION wait for the heavy-op gate.
 * Where `yieldDbHostLoopUnderMemoryPressure` throttles a backfill BETWEEN units
 * of work (FEA-3140), this parks a heavy op BEFORE it starts allocating — the
 * gate calls it once it has exclusivity, so GC / WAL-checkpoint can reclaim the
 * prior op's page-cache/RSS high-water before the next heavy op's peak lands on
 * top of it. It reuses the SAME `getMemoryPressure` signal (RSS/page-cache OR
 * heap) rather than duplicating the RSS logic.
 *
 * The wait is BOUNDED (maxWaits × delayMs, ~5s by default): if pressure won't
 * clear within the cap it resolves anyway so the op PROCEEDS rather than
 * deadlocking — admission throttles, it never starves. Not under pressure it
 * returns after a single cheap `getMemoryPressure()` read (no `setImmediate`
 * yield: exclusivity is already held and the op is about to run on the DB
 * thread), so steady-state admission cost is negligible. `getPressure`/
 * `delayMs`/`maxWaits` are injectable for tests.
 *
 * When a `log` is supplied it emits a one-shot line the FIRST time it parks (so
 * a heavy op that starts slow is self-describing as admission parking, sitting
 * next to the watchdog's pressure logs) and again if it exhausts `maxWaits` and
 * admits under still-high pressure. Steady-state (no parking) stays silent.
 */
export async function awaitMemoryPressureClearForAdmission(opts?: {
  getPressure?: () => MemoryPressure;
  delayMs?: number;
  maxWaits?: number;
  log?: (message: string) => void;
}): Promise<void> {
  const getPressure = opts?.getPressure ?? getMemoryPressure;
  const delayMs = opts?.delayMs ?? PRESSURE_DELAY_MS;
  const maxWaits = opts?.maxWaits ?? PRESSURE_MAX_WAITS;
  const log = opts?.log;
  let waits = 0;
  while (waits < maxWaits && getPressure().level === "high") {
    if (waits === 0) {
      log?.(
        `db-host heavy-op admission deferring under memory pressure (up to ${maxWaits} × ${delayMs}ms)`
      );
    }
    waits += 1;
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }
  if (waits === maxWaits && getPressure().level === "high") {
    log?.(
      `db-host heavy-op admitted after ${maxWaits} memory-pressure waits (still high)`
    );
  }
}
