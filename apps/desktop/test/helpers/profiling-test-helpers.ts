import type { ProfilingClock } from "../../src/shared/profiling.js";

/** Advances only when the test says so, so durations are exact, not timed. */
export function createTestClock(): ProfilingClock & {
  advance(ms: number): void;
} {
  let monotonic = 0;
  return {
    nowMs: () => monotonic,
    nowEpochMs: () => 1_700_000_000_000 + monotonic,
    advance(ms: number) {
      monotonic += ms;
    },
  };
}
