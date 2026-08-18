/**
 * @file db-host-memory-pressure-signal.test.ts
 * @description ISS-4823 — the db-host memory-pressure arm of the ISS-4711
 * adaptive rebuild pause, end to end across the process boundary.
 *
 * The rebuild's gate declared an `isDbHostUnderMemoryPressure()` input that NO
 * production call site supplied, so in the shipped app that disjunct was
 * permanently false: a several-thousand-session serial rebuild ran the whole
 * drain on the 0ms idle fast path even while the db host sat at its RSS
 * high-water. It is not redundant with the db host's own back-pressure — the
 * heavy-op gate's pre-admission wait and `yieldDbHostLoopUnderMemoryPressure`
 * cover the two `HEAVY_STORE_OPS` backfills, whereas `rebuildSessionFromParse`
 * reaches the writer through the generic invoke dispatch, which takes neither.
 *
 * `getMemoryPressure()` reads the CHILD's `process.memoryUsage()`, and the gate
 * is consulted synchronously once per session write, so the level cannot be
 * fetched on demand (and a callback can never cross the method proxy). The child
 * therefore PUBLISHES it and main answers from a cached value — which makes
 * staleness the load-bearing behavior these tests pin.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import {
  getMemoryPressure,
  MemoryPressureLevel,
  startHeapWatchdog,
} from "../src/main/database/db-host/db-host-memory-watchdog.js";
import {
  DbHostRequestKind,
  DbHostResponseKind,
  isDbHostResponse,
} from "../src/main/database/db-host/db-host-protocol.js";

const GIB = 1024 * 1024 * 1024;

describe("ISS-4823 db-host pressure publication (child side)", () => {
  test("the heap watchdog publishes a level derived from the SAME getMemoryPressure signal", () => {
    // The RSS arm is the one that matters here: the OOM's worst case is a
    // WAL/reader snapshot pinning the -wal into the OS page cache, which is
    // invisible to `heapUsed`. A publisher keyed only on the heap warn line
    // would stay silent through exactly that case.
    const heapOnlyQuiet = getMemoryPressure(
      { heapUsed: 1, rss: 20 * GIB },
      { warnHeapBytes: 8 * GIB, rssHighWaterBytes: 10 * GIB }
    );
    assert.equal(heapOnlyQuiet.level, MemoryPressureLevel.High);

    const quiet = getMemoryPressure(
      { heapUsed: 1, rss: 1 },
      { warnHeapBytes: 8 * GIB, rssHighWaterBytes: 10 * GIB }
    );
    assert.equal(quiet.level, MemoryPressureLevel.Ok);
  });

  test("the real publisher across quiet, repeated high, the falling edge, and after stop()", () => {
    // Drives the REAL sampling loop tick by tick with an injected clock and an
    // injected sample source, so the publisher's whole reporting policy is
    // exercised in-process. Asserting only that `stop()` left an empty array
    // would stay green if `onPressureChange` were never called at all.
    const timers = createFakeIntervals();
    const levels: MemoryPressureLevel[] = [];
    let sample = { heapUsed: 1, rss: 1 };
    const watchdog = startHeapWatchdog({
      log: () => undefined,
      warnHeapBytes: 8 * GIB,
      sampleIntervalMs: 1000,
      readMemoryUsage: () => sample,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
      onPressureChange: (level) => levels.push(level),
    });

    // Quiet: silent. Publishing "ok" every tick would be pure noise, and a
    // consumer keyed on staleness needs silence to MEAN quiet.
    timers.tick();
    timers.tick();
    assert.deepEqual(levels, []);

    // High: reported on EVERY sample, not just the rising edge — that repetition
    // is what lets main age a "high" out as stale instead of throttling forever
    // on a value nobody is refreshing.
    sample = { heapUsed: 1, rss: 20 * GIB };
    timers.tick();
    timers.tick();
    timers.tick();
    assert.deepEqual(levels, [
      MemoryPressureLevel.High,
      MemoryPressureLevel.High,
      MemoryPressureLevel.High,
    ]);

    // Falling edge: exactly one "ok", then silence again.
    sample = { heapUsed: 1, rss: 1 };
    timers.tick();
    timers.tick();
    assert.deepEqual(levels, [
      MemoryPressureLevel.High,
      MemoryPressureLevel.High,
      MemoryPressureLevel.High,
      MemoryPressureLevel.Ok,
    ]);

    // After stop(): the interval is cleared, so a tick that somehow fires
    // publishes nothing. A disposed watchdog must not keep feeding main a level
    // nobody owns.
    watchdog.stop();
    assert.equal(timers.cleared, 1);
    sample = { heapUsed: 1, rss: 20 * GIB };
    timers.tick();
    assert.deepEqual(levels, [
      MemoryPressureLevel.High,
      MemoryPressureLevel.High,
      MemoryPressureLevel.High,
      MemoryPressureLevel.Ok,
    ]);
  });

  test("the pressure message is a recognized db-host response", () => {
    // Version-skew guard: an unrecognized `kind` is dropped by the client's
    // validator, so a new message that is not registered here would be silently
    // discarded rather than loudly rejected.
    assert.equal(
      isDbHostResponse({
        kind: DbHostResponseKind.MemoryPressure,
        level: MemoryPressureLevel.High,
      }),
      true
    );
  });

  test("a pressure message with a missing or unknown level is REJECTED", () => {
    // The level is cached and answers the gate, so a malformed publication that
    // passed the boundary would evict a valid "high" and silently disable the
    // back-pressure this whole change adds.
    for (const malformed of [
      { kind: DbHostResponseKind.MemoryPressure },
      { kind: DbHostResponseKind.MemoryPressure, level: null },
      { kind: DbHostResponseKind.MemoryPressure, level: "" },
      { kind: DbHostResponseKind.MemoryPressure, level: "critical" },
      { kind: DbHostResponseKind.MemoryPressure, level: 1 },
    ]) {
      assert.equal(isDbHostResponse(malformed), false);
    }
  });
});

describe("ISS-4823 pressure caching + staleness (main side)", () => {
  /** Open a real DbHostClient over a fake forked child under a driven clock. */
  const openClient = async (): Promise<{
    client: DbHostClient;
    publish: (level: MemoryPressureLevel) => void;
    exit: () => void;
    setNow: (ms: number) => void;
  }> => {
    let clock = 0;
    let exitListener: ((code: number | null) => void) | undefined;
    let messageListener: ((message: unknown) => void) | undefined;
    const posted: { kind: string; id?: number }[] = [];
    const child = {
      stderr: null,
      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === "exit") {
          exitListener = listener as (code: number | null) => void;
        }
        if (event === "message") {
          messageListener = listener as (message: unknown) => void;
        }
        return child;
      },
      postMessage(message: { kind: string; id?: number }) {
        posted.push(message);
        if (message.kind === DbHostRequestKind.Init) {
          // Reply ready on the next turn so `start()` resolves.
          queueMicrotask(() =>
            messageListener?.({
              kind: DbHostResponseKind.Ready,
              id: message.id,
            })
          );
        }
      },
      kill() {
        // no-op
      },
    };
    const client = new DbHostClient({
      onEmit: () => undefined,
      onLog: () => undefined,
      now: () => clock,
      fork: () => child as unknown as never,
    });
    await client.start({ dataDir: "/tmp/iss-4823" });
    return {
      client,
      publish: (level) =>
        messageListener?.({
          kind: DbHostResponseKind.MemoryPressure,
          level,
        }),
      exit: () => exitListener?.(0),
      setNow: (ms) => {
        clock = ms;
      },
    };
  };

  test("a freshly published high reads as under pressure", async () => {
    const { client, publish, setNow } = await openClient();
    // Before any publication the gate must read clear, not "unknown".
    assert.equal(client.isUnderMemoryPressure(), false);

    setNow(1000);
    publish(MemoryPressureLevel.High);
    setNow(2000);
    assert.equal(client.isUnderMemoryPressure(), true);
  });

  test("a STALE high reads as NOT under pressure", async () => {
    // The load-bearing case. A "high" nobody is refreshing means a crashed or
    // wedged worker; treating it as live pressure would make the rebuild pay the
    // full 50ms-per-write pause indefinitely and reintroduce the multi-hour
    // drain ISS-4711 removed. Under-reporting only costs back-pressure that did
    // not exist here before; over-reporting costs the user hours.
    const { client, publish, setNow } = await openClient();
    setNow(1000);
    publish(MemoryPressureLevel.High);

    setNow(1000 + 5999);
    assert.equal(client.isUnderMemoryPressure(), true);
    setNow(1000 + 6000);
    assert.equal(client.isUnderMemoryPressure(), false);
  });

  test("a published ok clears a prior high", async () => {
    const { client, publish, setNow } = await openClient();
    setNow(1000);
    publish(MemoryPressureLevel.High);
    assert.equal(client.isUnderMemoryPressure(), true);

    publish(MemoryPressureLevel.Ok);
    assert.equal(client.isUnderMemoryPressure(), false);
  });

  test("a BACKWARD clock step reads as stale, not as indefinitely fresh", async () => {
    // `now` is wall-clock, which an NTP correction or a manual clock change can
    // step backward. A negative age would otherwise read as well inside the
    // freshness window and pin a "high" until wall time caught back up — the
    // indefinite full-pause the staleness bound exists to prevent.
    const { client, publish, setNow } = await openClient();
    setNow(10_000);
    publish(MemoryPressureLevel.High);
    assert.equal(client.isUnderMemoryPressure(), true);

    setNow(9000);
    assert.equal(client.isUnderMemoryPressure(), false);
  });

  test("a child EXIT drops the cached high immediately", async () => {
    const { client, publish, exit, setNow } = await openClient();
    setNow(1000);
    publish(MemoryPressureLevel.High);
    assert.equal(client.isUnderMemoryPressure(), true);

    // A dead worker publishes nothing, so its last reading describes a process
    // that no longer exists — it must not keep throttling the rebuild until the
    // staleness bound happens to expire.
    exit();
    assert.equal(client.isUnderMemoryPressure(), false);
  });
});

/**
 * A minimal interval harness: `tick()` runs the registered callback once, and a
 * cleared interval stops firing. Enough to drive the watchdog's sampling loop
 * deterministically without a wall-clock wait or a global timer stub.
 */
function createFakeIntervals(): {
  setIntervalFn: typeof setInterval;
  clearIntervalFn: typeof clearInterval;
  tick: () => void;
  cleared: number;
} {
  let callback: (() => void) | null = null;
  const handle = { unref: () => handle } as unknown as NodeJS.Timeout;
  const harness = {
    setIntervalFn: ((fn: () => void) => {
      callback = fn;
      return handle;
    }) as unknown as typeof setInterval,
    clearIntervalFn: (() => {
      callback = null;
      harness.cleared += 1;
    }) as unknown as typeof clearInterval,
    tick: () => callback?.(),
    cleared: 0,
  };
  return harness;
}
