/**
 * @file yield-db-host-loop.ts
 * @description FEA-2264 shared cooperative-yield helper for the DB-host child.
 *
 * SQLite/libSQL runs synchronously on ONE JS thread, and since ISS-8246 M1 that
 * thread is the STORE thread (`db-store-host.ts`) — which is where every
 * `desktop:db:*` read executes. A read reaches it as an `Execute` message on the
 * inner port, so the store thread picks it up only when its loop turns. A long
 * store op (the artifact-link backfill, a full-corpus session hydration) that
 * only ever awaits microtask-resolved promises never returns control to libuv's
 * poll phase, where those messages are delivered — so every queued read waits
 * out the whole op. A `setImmediate` boundary reaches the check phase and lets
 * them interleave BETWEEN units of work, WITHOUT the real per-iteration sleep a
 * main-side `cooperativeDelay` applies (the backfill passes thousands of
 * iterations, so a 50ms sleep each would add minutes). Callers that thread this
 * in as a `cooperativeDelay(ms)` intentionally ignore the `ms` argument: the
 * base `yieldDbHostLoop` yields, it does not sleep.
 *
 * ## M2 measured these calls rather than deleting them
 *
 * PLN-1837 M2 planned to delete the five plain calls as "inert on a thread with
 * no renderer reads". They are not inert, and none was deleted. Measured over a
 * `.backup` snapshot of a real 634 MB corpus, yields on versus collapsed to a
 * microtask: a read queued against the analytics aggregate waited 108–115 ms
 * instead of 270–279 ms (the whole op); a read queued mid hydration-sweep
 * started at 2109 ms instead of 2763 ms; the store thread's longest silent
 * window went 296 ms → 1287 ms. M1 changed WHICH thread stalls, not whether one
 * does.
 *
 * That evidence is a latency measurement and deliberately has no suite guard:
 * `no-timing-assertions` forbids writing one, and the non-timing proxies — a
 * loop-turn count, or "a macrotask queued against the op ran before it settled"
 * — stay green with every yield deleted (verified by mutation), so a guard built
 * on them would be a false green rather than protection. That holds for the
 * READ sweeps measured here, whose statements reach the loop through other
 * boundaries too. The IMPORT write path is different: between its record
 * groups there is no other loop turn at all, so the same proxy is a real guard
 * there — `test/import-yield-queued-reads.test.ts` (ISS-10401) pairs it with a
 * yields-collapsed control arm that reproduces the hang. Do not delete that
 * suite as a known false green.
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
} from "./db-host-memory-watchdog.js";
import { throwIfStoreReadCancelled } from "./store-read-cancellation.js";

/**
 * ISS-9802 — this is also the CANCELLATION CHECKPOINT, and it is the only one.
 *
 * The yield was already the one place a long store op hands the loop back, so it
 * is where a cancel posted while the op runs can first be seen. That fixes the
 * granularity at a STATEMENT BOUNDARY: an op abandons its remaining statements,
 * and the statement already inside the synchronous libSQL driver finishes first
 * because nothing at this layer can interrupt it.
 *
 * An op running with no cancellation scope — every write, every backfill, every
 * read from a caller that sent no token — sees no store and cannot throw here,
 * so the checkpoint is inert for them.
 */
export async function yieldDbHostLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  throwIfStoreReadCancelled();
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
 *
 * ISS-8246 M2 expected to CONVERT this to "a worker-appropriate throttle" and
 * found nothing to convert. Both of its jobs survived the M1 split intact: the
 * FEA-3132 real-sleep throttle keys on RSS, which is process-wide and therefore
 * unchanged by the store moving to a thread, and the FEA-2264 responsiveness
 * half now serves the store thread's own queued reads instead of the
 * dispatcher's. Its two callers (`db-store-ops.ts`) moved to that thread with
 * the backfills they wrap.
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
 * yield — the op is about to run on the DB thread anyway), so steady-state
 * admission cost is negligible. `getPressure`/`delayMs`/`maxWaits` are
 * injectable for tests.
 *
 * ISS-5941 — this now has TWO callers with DIFFERENT preconditions, so do not
 * assume exclusivity here:
 * - `createHeavyOpGate`'s mutex calls it holding the lock, one op at a time.
 * - `createBoundedOpLane` calls it with NO permit held (before acquiring), from
 *   an unbounded number of concurrent callers, and again after a QUEUED acquire
 *   with a permit held. So this function can be parked in by many callers at
 *   once. That is fine — it allocates nothing and only reads the pressure
 *   signal — but any future change that assumes a single in-flight caller, or
 *   that adds shared mutable state here, would be wrong for the lane.
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
