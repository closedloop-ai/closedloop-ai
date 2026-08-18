/**
 * @file ingest-progress-fixture.ts
 * @description The hand-driven clock/scheduler and tracker factory shared by the
 * `IngestProgressTracker` suites. Extracted (ISS-5281) when the producer-owned
 * `drained` signal earned its own focused sibling suite, rather than copying the
 * fixture or growing the console-observability suite past the 500-line smell.
 */

import {
  type IngestProgressClock,
  IngestProgressTracker,
} from "../../src/main/collectors/engine/collector-manager-ingest-progress.js";

export type TestIngestProgressClock = IngestProgressClock & {
  advanceTo(ms: number): void;
  tick(): void;
  scheduledIntervals: number[];
  cancelCount: number;
  isArmed(): boolean;
};

/** A hand-driven clock + scheduler so the stall sweep needs no real time. */
export function createTestClock(): TestIngestProgressClock {
  let current = 1_000_000;
  let callback: (() => void) | null = null;
  const scheduledIntervals: number[] = [];
  let cancelCount = 0;
  return {
    now: () => current,
    schedule(fn, intervalMs) {
      scheduledIntervals.push(intervalMs);
      callback = fn;
      return () => {
        cancelCount += 1;
        callback = null;
      };
    },
    advanceTo(ms) {
      current = ms;
    },
    tick() {
      callback?.();
    },
    scheduledIntervals,
    get cancelCount() {
      return cancelCount;
    },
    isArmed: () => callback !== null,
  };
}

/** A tracker wired to a hand-driven clock, with its log lines captured. */
export function createTracker(): {
  tracker: IngestProgressTracker;
  clock: TestIngestProgressClock;
  lines: string[];
} {
  const lines: string[] = [];
  const clock = createTestClock();
  const tracker = new IngestProgressTracker((message) => {
    lines.push(message);
  }, clock);
  return { tracker, clock, lines };
}
