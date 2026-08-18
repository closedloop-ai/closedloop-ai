import assert from "node:assert/strict";
import { test } from "node:test";

import { SessionLimitsBoot } from "../src/main/session-limits/session-limits-boot.js";

type Calls = {
  syncCapture: number;
  readerStarts: number;
  readerStops: number;
  usageStarts: number;
  usageDisposes: number;
};

function makeBoot(options: {
  goldenMode?: boolean;
  usageCaptureEnabled?: boolean;
  syncThrows?: boolean;
  readerThrows?: boolean;
  usageThrows?: boolean;
}) {
  const calls: Calls = {
    syncCapture: 0,
    readerStarts: 0,
    readerStops: 0,
    usageStarts: 0,
    usageDisposes: 0,
  };
  const boot = new SessionLimitsBoot({
    isGoldenMode: () => options.goldenMode === true,
    isUsageCaptureEnabled: () => options.usageCaptureEnabled === true,
    // Injected so no Electron-dependent module is ever loaded by these tests.
    loadStatuslineCaptureModule: () =>
      Promise.resolve({
        statuslineSnapshotPath: () => "/tmp/statusline-snapshot.json",
        syncStatuslineCaptureOnBoot: () => {
          calls.syncCapture++;
          if (options.syncThrows) {
            throw new Error("settings.json unreadable");
          }
        },
      }),
    createStatuslineReaderFn: (() =>
      ({
        start: () => {
          calls.readerStarts++;
          if (options.readerThrows) {
            throw new Error("reader failed to start");
          }
        },
        stop: () => {
          calls.readerStops++;
        },
      }) as never) as never,
    createUsageApiServiceFn: (() =>
      ({
        start: () => {
          calls.usageStarts++;
          if (options.usageThrows) {
            throw new Error("usage service failed to start");
          }
        },
        dispose: () => {
          calls.usageDisposes++;
        },
      }) as never) as never,
  });
  return { boot, calls };
}

test("start() runs every producer once", async () => {
  const { boot, calls } = makeBoot({});
  await boot.start();
  assert.equal(calls.syncCapture, 1);
  assert.equal(calls.readerStarts, 1);
  assert.equal(calls.usageStarts, 1);
});

test("golden mode starts NOTHING — no settings write, no credential read", async () => {
  const { boot, calls } = makeBoot({ goldenMode: true });
  await boot.start();
  assert.deepEqual(calls, {
    syncCapture: 0,
    readerStarts: 0,
    readerStops: 0,
    usageStarts: 0,
    usageDisposes: 0,
  });
});

test("a failing statusline capture does not stop the /usage producer", async () => {
  const { boot, calls } = makeBoot({ syncThrows: true, readerThrows: true });
  await assert.doesNotReject(() => boot.start());
  // Both earlier producers were attempted and failed…
  assert.equal(calls.syncCapture, 1);
  assert.equal(calls.readerStarts, 1);
  // …and the AUTHORITATIVE producer still started.
  assert.equal(calls.usageStarts, 1);
});

test("a failing /usage producer never throws into boot", async () => {
  const { boot } = makeBoot({ usageThrows: true });
  await assert.doesNotReject(() => boot.start());
});

test("stop() releases both producers' timers", async () => {
  const { boot, calls } = makeBoot({});
  await boot.start();
  boot.stop();
  assert.equal(calls.readerStops, 1);
  assert.equal(calls.usageDisposes, 1);
});

test("stop() before start() is safe", () => {
  const { boot, calls } = makeBoot({});
  assert.doesNotThrow(() => boot.stop());
  assert.equal(calls.readerStops, 0);
  assert.equal(calls.usageDisposes, 0);
});

test("start() is idempotent — producers are constructed once and reused", async () => {
  const { boot, calls } = makeBoot({});
  await boot.start();
  await boot.start();
  // start() is called again on the SAME instances, but only one of each exists,
  // so stop() still releases exactly one reader and one service.
  boot.stop();
  assert.equal(calls.readerStops, 1);
  assert.equal(calls.usageDisposes, 1);
});

test("the Labs gate is threaded into the /usage producer, not swallowed", async () => {
  // The boot seam still CONSTRUCTS and starts the producer; the producer itself
  // is what declines to read a credential. This asserts the gate value actually
  // reaches it rather than being dropped on the way through.
  let seenGate: (() => boolean) | null = null;
  const boot = new SessionLimitsBoot({
    isGoldenMode: () => false,
    isUsageCaptureEnabled: () => true,
    loadStatuslineCaptureModule: () =>
      Promise.resolve({
        statuslineSnapshotPath: () => "/tmp/s.json",
        syncStatuslineCaptureOnBoot: () => undefined,
      }),
    createStatuslineReaderFn: (() =>
      ({ start: () => undefined, stop: () => undefined }) as never) as never,
    createUsageApiServiceFn: ((options: { isEnabled: () => boolean }) => {
      seenGate = options.isEnabled;
      return { start: () => undefined, dispose: () => undefined } as never;
    }) as never,
  });
  await boot.start();
  assert.ok(seenGate, "the /usage producer was never given a gate");
  assert.equal((seenGate as unknown as () => boolean)(), true);
});
