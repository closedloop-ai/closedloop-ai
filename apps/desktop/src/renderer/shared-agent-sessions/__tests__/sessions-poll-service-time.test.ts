import { describe, expect, it } from "vitest";
import {
  createServiceTimeTracker,
  nextPollIntervalMs,
} from "../sessions-poll-service-time";

/**
 * The Sessions page-data poll used a FIXED 2000 ms interval while the read it
 * polls costs ~2.1 s on a real 2,962-session population — an arrival rate above
 * the service rate, which saturates the db-host's 2-permit read lane and makes
 * reads miss their 10 s deadline on queue wait rather than on query time.
 *
 * These pin the rule that fixes it: never schedule the next poll sooner than the
 * last read took.
 */
describe("nextPollIntervalMs", () => {
  const floorMs = 2000;
  const ceilingMs = 30_000;

  it("returns the floor before any read has been observed", () => {
    // Pre-measurement behaviour must equal the fixed cadence this replaced, so a
    // build whose observation wiring never fires is no worse than today.
    expect(
      nextPollIntervalMs({ observedServiceMs: null, floorMs, ceilingMs })
    ).toBe(floorMs);
  });

  it("follows the read cost once it exceeds the floor", () => {
    // 2.1s read against a 2.0s floor: the interval must follow the read, not the
    // constant, so the duty cycle stays at ~50% instead of climbing with cost.
    expect(
      nextPollIntervalMs({ observedServiceMs: 2100, floorMs, ceilingMs })
    ).toBe(2100);
  });

  it("keeps the floor when reads are faster than it", () => {
    // A cheap corpus must not poll in a tight loop just because it can.
    expect(
      nextPollIntervalMs({ observedServiceMs: 40, floorMs, ceilingMs })
    ).toBe(floorMs);
  });

  it("caps at the ceiling so a slow read cannot defer the heal forever", () => {
    // Backing off without a bound would reintroduce the FEA-2187 stuck-list bug
    // from the opposite direction.
    expect(
      nextPollIntervalMs({ observedServiceMs: 120_000, floorMs, ceilingMs })
    ).toBe(ceilingMs);
  });

  it("falls back to the floor on a non-finite estimate", () => {
    expect(
      nextPollIntervalMs({
        observedServiceMs: Number.NaN,
        floorMs,
        ceilingMs,
      })
    ).toBe(floorMs);
  });

  it("prefers the floor when a caller passes a ceiling below it", () => {
    // A degenerate bound must not collapse the guaranteed minimum cadence.
    expect(
      nextPollIntervalMs({ observedServiceMs: 5000, floorMs, ceilingMs: 500 })
    ).toBe(floorMs);
  });
});

describe("createServiceTimeTracker", () => {
  it("has no estimate until a sample lands", () => {
    expect(createServiceTimeTracker().observedMs()).toBeNull();
  });

  it("adopts the first sample outright, then smooths toward later ones", () => {
    const tracker = createServiceTimeTracker(0.5);
    tracker.record(2000);
    expect(tracker.observedMs()).toBe(2000);
    tracker.record(4000);
    expect(tracker.observedMs()).toBe(3000);
  });

  it("damps a single anomalous read rather than slamming the cadence", () => {
    // One cold-cache or GC-stalled read must not push the list to the ceiling
    // and leave a hidden renderer stale for half a minute.
    const tracker = createServiceTimeTracker(0.3);
    tracker.record(2000);
    tracker.record(60_000);
    const observed = tracker.observedMs() ?? 0;
    expect(observed).toBeLessThan(30_000);
    expect(observed).toBeGreaterThan(2000);
  });

  it("drops non-finite and negative samples instead of poisoning the estimate", () => {
    // A poisoned estimate stalls the poll, which is worse than the bug fixed.
    const tracker = createServiceTimeTracker();
    tracker.record(2000);
    tracker.record(Number.NaN);
    tracker.record(Number.POSITIVE_INFINITY);
    tracker.record(-500);
    expect(tracker.observedMs()).toBe(2000);
  });
});
