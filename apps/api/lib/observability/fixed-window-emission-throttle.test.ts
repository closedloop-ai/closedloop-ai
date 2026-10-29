/**
 * ISS-6890. A throttle added to bound an unbounded log stream is only a fix if
 * the throttle's OWN state is bounded — a keyed `Map` fed from caller-reachable
 * input trades a log leak for a memory leak (root `AGENTS.md`: in-memory maps
 * used as caches or rate limiters must have bounded growth).
 *
 * Time is injected, never faked or slept: every case passes `now` explicitly.
 */

import { describe, expect, it } from "vitest";
import {
  EmissionRollupCause,
  FIXED_WINDOW_EMISSION_MAX_ENTRIES,
  FixedWindowEmissionThrottle,
} from "./fixed-window-emission-throttle";

const WINDOW_MS = 60_000;

type RosterKeyParts = {
  organizationId: string;
  sessionId: string;
  reason: string;
};

function rosterKey(parts: RosterKeyParts): string {
  return [parts.organizationId, parts.sessionId, parts.reason].join("|");
}

describe("FixedWindowEmissionThrottle", () => {
  it("emits the first occurrence in a window and suppresses the rest", () => {
    const throttle = new FixedWindowEmissionThrottle<string>({
      windowMs: WINDOW_MS,
    });

    expect(throttle.record("k", "k", 0)).toEqual({
      emit: true,
      flushedSuppressedCount: 0,
    });
    for (let i = 1; i < 500; i += 1) {
      expect(throttle.record("k", "k", i)).toEqual({
        emit: false,
        flushedSuppressedCount: 0,
      });
    }
  });

  it("flushes the suppressed total when the window rolls over", () => {
    const throttle = new FixedWindowEmissionThrottle<string>({
      windowMs: WINDOW_MS,
    });

    throttle.record("k", "k", 0);
    throttle.record("k", "k", 1);
    throttle.record("k", "k", 2);

    // 1 emitted + 2 suppressed = the 3 occurrences that actually happened, so
    // sum(occurrences) across the emitted events stays exact.
    expect(throttle.record("k", "k", WINDOW_MS)).toEqual({
      emit: true,
      flushedSuppressedCount: 2,
    });
  });

  it("bounds its keyspace under a flood of DISTINCT org/session/reason keys", () => {
    const maxEntries = 8;
    const throttle = new FixedWindowEmissionThrottle<RosterKeyParts>({
      windowMs: WINDOW_MS,
      maxEntries,
    });

    // Every key is distinct in all three parts, inside one window, so nothing
    // can expire — the ONLY thing that can hold the map down is the cap. This is
    // the case an unbounded Map fails: it would end at 400 entries.
    for (let i = 0; i < 400; i += 1) {
      const parts: RosterKeyParts = {
        organizationId: `org-${i}`,
        sessionId: `session-${i}`,
        reason: `reason-${i}`,
      };
      throttle.record(rosterKey(parts), parts, 0);
      expect(throttle.size).toBeLessThanOrEqual(maxEntries);
    }

    expect(throttle.size).toBe(maxEntries);
  });

  it("flushes an evicted key's suppressed count instead of dropping it", () => {
    const flushed: Array<{ sessionId: string; count: number }> = [];
    const throttle = new FixedWindowEmissionThrottle<RosterKeyParts>({
      windowMs: WINDOW_MS,
      maxEntries: 1,
      onFlush: (parts, count) => {
        flushed.push({ sessionId: parts.sessionId, count });
      },
    });
    const victim: RosterKeyParts = {
      organizationId: "org-a",
      sessionId: "session-a",
      reason: "unreadable_members",
    };
    const intruder: RosterKeyParts = {
      organizationId: "org-b",
      sessionId: "session-b",
      reason: "unreadable_members",
    };

    throttle.record(rosterKey(victim), victim, 0);
    throttle.record(rosterKey(victim), victim, 1);
    throttle.record(rosterKey(victim), victim, 2);
    // Exceeds the cap and evicts the victim; its 2 suppressed occurrences must
    // reach the aggregate rather than vanish with the entry.
    throttle.record(rosterKey(intruder), intruder, 3);

    expect(flushed).toEqual([{ sessionId: "session-a", count: 2 }]);
  });

  it("does not flush an evicted key that suppressed nothing", () => {
    const flushed: number[] = [];
    const throttle = new FixedWindowEmissionThrottle<string>({
      windowMs: WINDOW_MS,
      maxEntries: 1,
      onFlush: (_context, count) => {
        flushed.push(count);
      },
    });

    throttle.record("a", "a", 0);
    throttle.record("b", "b", 1);

    expect(flushed).toEqual([]);
  });

  it("throttles distinct keys independently", () => {
    const throttle = new FixedWindowEmissionThrottle<string>({
      windowMs: WINDOW_MS,
    });

    expect(throttle.record("a", "a", 0).emit).toBe(true);
    expect(throttle.record("b", "b", 0).emit).toBe(true);
    expect(throttle.record("a", "a", 1).emit).toBe(false);
  });

  it("defaults to a bounded keyspace when no cap is supplied", () => {
    // The production instances construct this without `maxEntries`, so the
    // default must itself be a finite cap rather than "unbounded until told".
    expect(Number.isFinite(FIXED_WINDOW_EMISSION_MAX_ENTRIES)).toBe(true);
    const throttle = new FixedWindowEmissionThrottle<string>({ maxEntries: 3 });
    for (let i = 0; i < 50; i += 1) {
      throttle.record(`k-${i}`, `k-${i}`, 0);
    }
    expect(throttle.size).toBe(3);
  });

  it("spends a raised per-window budget before suppressing, and rolls the rest up", () => {
    // #5209 review: a caller may use a COARSE key as a spending budget rather
    // than a correlation key. The budget must be a real ceiling — the N+1th
    // occurrence is suppressed, not emitted — and the overflow still reaches the
    // additive total through the next window's rollup.
    const BUDGET = 3;
    const throttle = new FixedWindowEmissionThrottle<string>({
      windowMs: WINDOW_MS,
      maxPerWindow: BUDGET,
    });

    const emitted = Array.from(
      { length: BUDGET + 2 },
      (_, index) => throttle.record("k", "k", index).emit
    );

    expect(emitted).toEqual([true, true, true, false, false]);
    expect(throttle.record("k", "k", WINDOW_MS).flushedSuppressedCount).toBe(2);
  });

  it("preserves weighted occurrences through a suppressed rollup", () => {
    const throttle = new FixedWindowEmissionThrottle<string>({
      windowMs: WINDOW_MS,
    });

    expect(throttle.recordOccurrences("k", "k", 0, 5)).toEqual({
      emit: true,
      flushedSuppressedCount: 0,
    });
    expect(throttle.recordOccurrences("k", "k", 1, 7)).toEqual({
      emit: false,
      flushedSuppressedCount: 0,
    });
    expect(throttle.recordOccurrences("k", "k", WINDOW_MS, 3)).toEqual({
      emit: true,
      flushedSuppressedCount: 7,
    });
  });

  it("refuses invalid occurrence weights", () => {
    const throttle = new FixedWindowEmissionThrottle<string>();

    expect(() => throttle.recordOccurrences("k", "k", 0, 0)).toThrow(
      "occurrences must be a positive safe integer"
    );
    expect(() => throttle.recordOccurrences("k", "k", 0, 1.5)).toThrow(
      "occurrences must be a positive safe integer"
    );
  });

  /**
   * #5508 review (whitlockk): before `drainExpired`, a suppressed count was only
   * materialised when the SAME key was touched again after rollover, or when
   * the map overflowed. A burst followed by quiet therefore left occurrences in
   * process memory indefinitely — exactly the shape abuse takes.
   */
  it("drains a closed window's suppressed count without the key being touched again", () => {
    const flushed: number[] = [];
    const throttle = new FixedWindowEmissionThrottle<string>({
      windowMs: WINDOW_MS,
      onFlush: (_context, count) => {
        flushed.push(count);
      },
    });

    throttle.record("k", "k", 0);
    throttle.record("k", "k", 1);
    throttle.record("k", "k", 2);

    expect(throttle.drainExpired(WINDOW_MS * 2)).toBe(1);
    expect(flushed).toEqual([2]);
    // Dropped, not merely flushed: a drained key must not re-flush the same
    // occurrences when the caller's next drain comes round.
    expect(throttle.size).toBe(0);
    expect(throttle.drainExpired(WINDOW_MS * 10)).toBe(0);
    expect(flushed).toEqual([2]);
  });

  it("leaves a live window alone", () => {
    const flushed: number[] = [];
    const throttle = new FixedWindowEmissionThrottle<string>({
      windowMs: WINDOW_MS,
      onFlush: (_context, count) => {
        flushed.push(count);
      },
    });

    throttle.record("k", "k", 0);
    throttle.record("k", "k", 1);

    expect(throttle.drainExpired(WINDOW_MS - 1)).toBe(0);
    expect(flushed).toEqual([]);
    expect(throttle.size).toBe(1);
  });

  it("drains a closed window that suppressed nothing without calling onFlush", () => {
    const flushed: number[] = [];
    const throttle = new FixedWindowEmissionThrottle<string>({
      windowMs: WINDOW_MS,
      onFlush: (_context, count) => {
        flushed.push(count);
      },
    });

    throttle.record("k", "k", 0);

    expect(throttle.drainExpired(WINDOW_MS)).toBe(1);
    // A rollup of zero denials is not an observation; emitting one would put a
    // phantom occurrence in the monitored stream.
    expect(flushed).toEqual([]);
  });

  /**
   * The residual the drain's bound deliberately accepts, asserted rather than
   * left as prose. The walk stops at the first key it cannot PROVE is expired
   * — which is what makes it O(1) on a quiet request — so a key touched
   * mid-window waits past its own `resetAt` until `lastTouchedAt + windowMs`.
   * The lag is bounded by under two windows; it is not zero, and the module
   * docstring must not claim otherwise.
   */
  it("defers a key whose window closed early, then still drains it", () => {
    const flushed: number[] = [];
    const throttle = new FixedWindowEmissionThrottle<string>({
      windowMs: WINDOW_MS,
      onFlush: (_context, count) => {
        flushed.push(count);
      },
    });

    throttle.record("k", "k", 0);
    // Touched mid-window: `resetAt` is still WINDOW_MS, but the last touch is
    // half a window later.
    throttle.record("k", "k", WINDOW_MS / 2);

    // The window is over at exactly WINDOW_MS, yet the drain cannot prove it
    // and declines rather than risk flushing a live window.
    expect(throttle.drainExpired(WINDOW_MS)).toBe(0);
    expect(flushed).toEqual([]);

    // Nothing is lost — the next drain past the provable bound takes it.
    expect(throttle.drainExpired(WINDOW_MS + WINDOW_MS / 2)).toBe(1);
    expect(flushed).toEqual([1]);
  });

  it("drains every expired key in one pass", () => {
    const flushed: string[] = [];
    const throttle = new FixedWindowEmissionThrottle<string>({
      windowMs: WINDOW_MS,
      onFlush: (context) => {
        flushed.push(context);
      },
    });

    for (const key of ["a", "b", "c"]) {
      throttle.record(key, key, 0);
      throttle.record(key, key, 1);
    }

    expect(throttle.drainExpired(WINDOW_MS + 1)).toBe(3);
    expect(flushed).toEqual(["a", "b", "c"]);
    expect(throttle.size).toBe(0);
  });

  /**
   * ISS-7360: the two causes this class raises must be DISTINGUISHABLE at the
   * `onFlush` boundary. Every other case here ignores the third argument, so a
   * swap of the two labels — or a class that reported one constant for both —
   * survived the whole suite, and `flushedBy` is the only facet that tells
   * keyspace pressure apart from an ordinary quiet key.
   */
  it("reports which terminal path materialised each suppressed count", () => {
    const flushed: Array<{ context: string; count: number; cause: string }> =
      [];
    const throttle = new FixedWindowEmissionThrottle<string>({
      windowMs: WINDOW_MS,
      maxEntries: 1,
      onFlush: (context, count, cause) => {
        flushed.push({ context, count, cause });
      },
    });

    // `evicted` leaves by the keyspace cap: 3 occurrences, 2 suppressed, then a
    // second key arrives inside the same window and pushes it out.
    throttle.record("evicted", "evicted", 0);
    throttle.record("evicted", "evicted", 1);
    throttle.record("evicted", "evicted", 2);
    throttle.record("survivor", "survivor", 3);

    expect(flushed).toEqual([
      { context: "evicted", count: 2, cause: EmissionRollupCause.Eviction },
    ]);

    // `survivor` leaves by the clock instead: one suppressed occurrence, then
    // quiet, then a drain past its window.
    throttle.record("survivor", "survivor", 4);
    throttle.drainExpired(WINDOW_MS * 2);

    expect(flushed).toEqual([
      { context: "evicted", count: 2, cause: EmissionRollupCause.Eviction },
      { context: "survivor", count: 1, cause: EmissionRollupCause.Expiry },
    ]);
  });

  it("defaults the per-window budget to one, so an existing caller is unchanged", () => {
    const throttle = new FixedWindowEmissionThrottle<string>({
      windowMs: WINDOW_MS,
    });

    expect(throttle.record("k", "k", 0).emit).toBe(true);
    expect(throttle.record("k", "k", 1).emit).toBe(false);
  });
});
