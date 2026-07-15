/**
 * @file db-host-memory-pressure.test.ts
 * @description FEA-3132 (E3/E4) — the memory-pressure signal must fire on RSS,
 * not just heapUsed (the audit's central correction: the WAL/page-cache OOM path
 * is invisible to heapUsed), and the memory-aware yield must PARK a backfill
 * while pressure is high and PROCEED once it clears — bounded, never infinite.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getMemoryPressure } from "../src/main/database/db-host/db-host-memory-watchdog.js";
import {
  awaitMemoryPressureClearForAdmission,
  yieldDbHostLoopUnderMemoryPressure,
} from "../src/main/database/yield-db-host-loop.js";

const HEAP_HIGH = 8 * 1024 * 1024 * 1024;
const RSS_HIGH = 10 * 1024 * 1024 * 1024;
const PARKING_LOG = /parking under memory pressure/;
const PROCEEDING_LOG = /proceeding after 2 memory-pressure waits/;
const ADMISSION_DEFER_LOG = /admission deferring under memory pressure/;
const ADMISSION_ADMITTED_LOG = /admitted after 2 memory-pressure waits/;
const thresholds = {
  warnHeapBytes: HEAP_HIGH,
  rssHighWaterBytes: RSS_HIGH,
};

test("getMemoryPressure is 'ok' when both heap and rss are below the water lines", () => {
  const p = getMemoryPressure({ heapUsed: 1e9, rss: 2e9 }, thresholds);
  assert.equal(p.level, "ok");
});

test("getMemoryPressure is 'high' on heap pressure alone", () => {
  const p = getMemoryPressure({ heapUsed: HEAP_HIGH, rss: 1e9 }, thresholds);
  assert.equal(p.level, "high");
});

test("getMemoryPressure is 'high' on RSS pressure even when heap is low", () => {
  // The critical case: heapUsed nowhere near the ceiling, but rss (WAL/page
  // cache) is over the machine-relative high-water — a heap-only signal would
  // miss this and let the OS OOM-kill the process.
  const p = getMemoryPressure({ heapUsed: 500e6, rss: RSS_HIGH }, thresholds);
  assert.equal(p.level, "high");
});

test("yieldDbHostLoopUnderMemoryPressure returns immediately when pressure is ok", async () => {
  let calls = 0;
  await yieldDbHostLoopUnderMemoryPressure({
    getPressure: () => {
      calls += 1;
      return { level: "ok", heapUsed: 0, rss: 0 };
    },
    delayMs: 1,
    maxWaits: 10,
  });
  // One check, no parking.
  assert.equal(calls, 1);
});

test("yieldDbHostLoopUnderMemoryPressure parks while high, then proceeds when it clears", async () => {
  let calls = 0;
  await yieldDbHostLoopUnderMemoryPressure({
    getPressure: () => {
      calls += 1;
      // high for the first two checks, then clears
      return calls <= 2
        ? { level: "high", heapUsed: 0, rss: 0 }
        : { level: "ok", heapUsed: 0, rss: 0 };
    },
    delayMs: 1,
    maxWaits: 10,
  });
  // 2 high checks (each parks) + 1 ok check that exits the loop.
  assert.equal(calls, 3);
});

test("yieldDbHostLoopUnderMemoryPressure is bounded: proceeds after maxWaits under sustained pressure", async () => {
  let calls = 0;
  await yieldDbHostLoopUnderMemoryPressure({
    getPressure: () => {
      calls += 1;
      return { level: "high", heapUsed: 0, rss: 0 };
    },
    delayMs: 1,
    maxWaits: 3,
  });
  // Loop runs exactly maxWaits times (checks pressure each), then re-checks
  // once for the "proceeded while still high" log, then proceeds — never stalls
  // forever.
  assert.equal(calls, 4);
});

test("yieldDbHostLoopUnderMemoryPressure logs once on first park and never when pressure is ok", async () => {
  const logs: string[] = [];
  // ok: no parking, no log.
  await yieldDbHostLoopUnderMemoryPressure({
    getPressure: () => ({ level: "ok", heapUsed: 0, rss: 0 }),
    delayMs: 1,
    maxWaits: 5,
    log: (m) => logs.push(m),
  });
  assert.equal(logs.length, 0);

  // parks twice then clears: exactly one "parking" line (rising edge only), no
  // "proceeding under still-high" line since it cleared.
  let calls = 0;
  await yieldDbHostLoopUnderMemoryPressure({
    getPressure: () => {
      calls += 1;
      return calls <= 2
        ? { level: "high", heapUsed: 0, rss: 0 }
        : { level: "ok", heapUsed: 0, rss: 0 };
    },
    delayMs: 1,
    maxWaits: 5,
    log: (m) => logs.push(m),
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], PARKING_LOG);
});

test("yieldDbHostLoopUnderMemoryPressure logs when it exhausts maxWaits and proceeds", async () => {
  const logs: string[] = [];
  await yieldDbHostLoopUnderMemoryPressure({
    getPressure: () => ({ level: "high", heapUsed: 0, rss: 0 }),
    delayMs: 1,
    maxWaits: 2,
    log: (m) => logs.push(m),
  });
  // One rising-edge "parking" line + one "proceeding … still high" line.
  assert.equal(logs.length, 2);
  assert.match(logs[0], PARKING_LOG);
  assert.match(logs[1], PROCEEDING_LOG);
});

// FEA-3150 (FEA-3132 P1): the pre-admission wait the heavy-op gate uses. Same
// bounded-park contract as the backfill yield above, but it admits (returns)
// rather than yielding a setImmediate turn afterward.
test("awaitMemoryPressureClearForAdmission admits immediately when pressure is ok", async () => {
  let calls = 0;
  await awaitMemoryPressureClearForAdmission({
    getPressure: () => {
      calls += 1;
      return { level: "ok", heapUsed: 0, rss: 0 };
    },
    delayMs: 1,
    maxWaits: 10,
  });
  // A single pressure check, no parking.
  assert.equal(calls, 1);
});

test("awaitMemoryPressureClearForAdmission defers while high, then admits when it clears", async () => {
  let calls = 0;
  await awaitMemoryPressureClearForAdmission({
    getPressure: () => {
      calls += 1;
      return calls <= 2
        ? { level: "high", heapUsed: 0, rss: 0 }
        : { level: "ok", heapUsed: 0, rss: 0 };
    },
    delayMs: 1,
    maxWaits: 10,
  });
  // 2 high checks (each parks) + 1 ok check that admits.
  assert.equal(calls, 3);
});

test("awaitMemoryPressureClearForAdmission is bounded: admits after maxWaits under sustained pressure", async () => {
  let calls = 0;
  await awaitMemoryPressureClearForAdmission({
    getPressure: () => {
      calls += 1;
      return { level: "high", heapUsed: 0, rss: 0 };
    },
    delayMs: 1,
    maxWaits: 3,
  });
  // maxWaits high checks + one final check for the "admitted while still high"
  // log, then admits — never deadlocks under sustained pressure.
  assert.equal(calls, 4);
});

test("awaitMemoryPressureClearForAdmission logs once on defer, then on bounded admit", async () => {
  const logs: string[] = [];
  // ok: no parking, no log.
  await awaitMemoryPressureClearForAdmission({
    getPressure: () => ({ level: "ok", heapUsed: 0, rss: 0 }),
    delayMs: 1,
    maxWaits: 5,
    log: (m) => logs.push(m),
  });
  assert.equal(logs.length, 0);

  // sustained high for maxWaits=2: one rising-edge defer line + one bounded
  // "admitted after 2 … still high" line.
  await awaitMemoryPressureClearForAdmission({
    getPressure: () => ({ level: "high", heapUsed: 0, rss: 0 }),
    delayMs: 1,
    maxWaits: 2,
    log: (m) => logs.push(m),
  });
  assert.equal(logs.length, 2);
  assert.match(logs[0], ADMISSION_DEFER_LOG);
  assert.match(logs[1], ADMISSION_ADMITTED_LOG);
});
