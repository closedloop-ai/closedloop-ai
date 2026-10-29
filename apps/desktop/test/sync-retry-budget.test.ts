/**
 * @file sync-retry-budget.test.ts
 * @description ISS-8615 (PRD-699 §7.3): the shared typed retry-budget table.
 *
 * Every expected value here is a LITERAL written against the standard, not a
 * re-derivation from the module under test: a test that computes its expectation
 * the way the implementation does cannot fail when the implementation is wrong.
 * The horizons are spelled in whole milliseconds for the same reason.
 *
 * No fake timers and no clock: the whole point of `{state, now}` is that `now` is
 * an argument, so every case pins an instant by passing one. A suite that had to
 * freeze a clock to test these would be evidence they were not pure.
 */
import { describe, expect, it } from "vitest";
import {
  isSyncRetryBudgetSpent,
  SYNC_RETRY_BUDGET_FLOOR,
  type SyncRetryBudget,
  SyncRetryBudgetKind,
  syncRetryBudgetRemainingMs,
} from "../src/shared/sync-retry-budget.js";

/** An arbitrary fixed reading instant. Nothing depends on its value. */
const NOW_MS = 1_800_000_000_000;

const ONE_HOUR_MS = 3_600_000;
const ONE_DAY_MS = 86_400_000;

function attemptsBudget(
  maxAttempts: number,
  permanent = true
): SyncRetryBudget {
  return { kind: SyncRetryBudgetKind.Attempts, permanent, maxAttempts };
}

function stateAfter(attemptCount: number, originMs: number | null = null) {
  return { attemptCount, originMs, nowMs: NOW_MS };
}

describe("SyncRetryBudgetKind", () => {
  it("names exactly the three arms the standard defines", () => {
    // Written out rather than derived from the const object: a member silently
    // renamed or dropped has to break this line, and `Object.keys(...)` compared
    // against itself never would.
    expect(SyncRetryBudgetKind.Attempts).toBe("attempts");
    expect(SyncRetryBudgetKind.Age).toBe("age");
    expect(SyncRetryBudgetKind.WallClock).toBe("wall_clock");
    expect(Object.keys(SyncRetryBudgetKind)).toHaveLength(3);
  });
});

describe("isSyncRetryBudgetSpent — attempts arm", () => {
  it("is spent once the post-increment count reaches the cap", () => {
    expect(isSyncRetryBudgetSpent(attemptsBudget(3), stateAfter(3))).toBe(true);
  });

  it("is NOT spent one attempt short of the cap", () => {
    expect(isSyncRetryBudgetSpent(attemptsBudget(3), stateAfter(2))).toBe(
      false
    );
  });

  it("refuses to spend on a failure the lane did not attribute to the row", () => {
    // Invariant 4. The positive sibling above is what proves this `false` is the
    // gate answering and not a budget that never expires.
    expect(
      isSyncRetryBudgetSpent(attemptsBudget(3, false), stateAfter(99))
    ).toBe(false);
  });

  it("ignores the origin entirely — tries, not elapsed time", () => {
    const aDayOfStalling = {
      attemptCount: 1,
      originMs: NOW_MS - ONE_DAY_MS,
      nowMs: NOW_MS,
    };
    expect(isSyncRetryBudgetSpent(attemptsBudget(3), aDayOfStalling)).toBe(
      false
    );
  });
});

describe("isSyncRetryBudgetSpent — age and wall-clock arms", () => {
  it("spends an age horizon at exactly the horizon, not a millisecond later", () => {
    const budget: SyncRetryBudget = {
      kind: SyncRetryBudgetKind.Age,
      ageHorizonMs: ONE_DAY_MS,
    };
    expect(
      isSyncRetryBudgetSpent(budget, stateAfter(0, NOW_MS - ONE_DAY_MS))
    ).toBe(true);
    expect(
      isSyncRetryBudgetSpent(budget, stateAfter(0, NOW_MS - ONE_DAY_MS + 1))
    ).toBe(false);
  });

  it("spends a wall clock at exactly the ceiling, not a millisecond later", () => {
    const budget: SyncRetryBudget = {
      kind: SyncRetryBudgetKind.WallClock,
      ceilingMs: ONE_DAY_MS,
    };
    expect(
      isSyncRetryBudgetSpent(budget, stateAfter(0, NOW_MS - ONE_DAY_MS))
    ).toBe(true);
    expect(
      isSyncRetryBudgetSpent(budget, stateAfter(0, NOW_MS - ONE_DAY_MS + 1))
    ).toBe(false);
  });

  it("treats an UNKNOWN origin as unspent rather than expired", () => {
    // A `lane_stalled_since` that would not parse must not dead-letter a healthy
    // row on the first unreadable column.
    const budget: SyncRetryBudget = {
      kind: SyncRetryBudgetKind.WallClock,
      ceilingMs: ONE_DAY_MS,
    };
    expect(isSyncRetryBudgetSpent(budget, stateAfter(0, null))).toBe(false);
    expect(isSyncRetryBudgetSpent(budget, stateAfter(0, Number.NaN))).toBe(
      false
    );
  });

  it("clamps a FUTURE origin to zero elapsed instead of leaving it negative", () => {
    // Clock skew. Negative elapsed makes the ceiling unreachable forever, which
    // is the silent unbounded retry arriving by arithmetic.
    const budget: SyncRetryBudget = {
      kind: SyncRetryBudgetKind.WallClock,
      ceilingMs: ONE_DAY_MS,
    };
    const skewed = stateAfter(0, NOW_MS + ONE_DAY_MS * 365);
    expect(isSyncRetryBudgetSpent(budget, skewed)).toBe(false);
    expect(syncRetryBudgetRemainingMs(budget, skewed)).toBe(ONE_DAY_MS);
  });
});

describe("isSyncRetryBudgetSpent — the whole impossible-magnitude set", () => {
  it("floors a zero, negative, or fractional attempt cap at one attempt", () => {
    expect(SYNC_RETRY_BUDGET_FLOOR).toBe(1);
    for (const corrupt of [0, -5, 0.5]) {
      expect(
        isSyncRetryBudgetSpent(attemptsBudget(corrupt), stateAfter(1))
      ).toBe(true);
    }
  });

  it("floors a NON-FINITE cap rather than letting it retry forever", () => {
    // The direction is the point: failing toward the bound dead-letters one row
    // recoverably and loudly; failing the other way removes invariant 5's
    // terminal path and looks exactly like a healthy backoff.
    for (const corrupt of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        isSyncRetryBudgetSpent(attemptsBudget(corrupt), stateAfter(1))
      ).toBe(true);
    }
  });

  it("floors a corrupt time horizon the same way, on both time arms", () => {
    const oneMsAgo = stateAfter(0, NOW_MS - 1);
    for (const corrupt of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        isSyncRetryBudgetSpent(
          { kind: SyncRetryBudgetKind.Age, ageHorizonMs: corrupt },
          oneMsAgo
        )
      ).toBe(true);
      expect(
        isSyncRetryBudgetSpent(
          { kind: SyncRetryBudgetKind.WallClock, ceilingMs: corrupt },
          oneMsAgo
        )
      ).toBe(true);
    }
  });

  it("does not spend an attempts budget on a non-finite COUNT", () => {
    // A corrupt count is not evidence the row tried; only a corrupt CAP is
    // evidence the bound is unusable.
    expect(
      isSyncRetryBudgetSpent(attemptsBudget(3), stateAfter(Number.NaN))
    ).toBe(false);
  });
});

describe("syncRetryBudgetRemainingMs", () => {
  it("reports the remainder of a time budget", () => {
    expect(
      syncRetryBudgetRemainingMs(
        { kind: SyncRetryBudgetKind.WallClock, ceilingMs: ONE_DAY_MS },
        stateAfter(0, NOW_MS - ONE_HOUR_MS)
      )
    ).toBe(82_800_000);
  });

  it("goes NEGATIVE past the ceiling instead of clamping to zero", () => {
    // A zero here would schedule a retry every tick on a row whose ack-gated
    // terminal cannot land — strictly worse than the flat delay it replaced.
    expect(
      syncRetryBudgetRemainingMs(
        { kind: SyncRetryBudgetKind.WallClock, ceilingMs: ONE_DAY_MS },
        stateAfter(0, NOW_MS - ONE_DAY_MS - ONE_HOUR_MS)
      )
    ).toBe(-ONE_HOUR_MS);
  });

  it("has no answer for an attempts budget, and says so with null", () => {
    expect(syncRetryBudgetRemainingMs(attemptsBudget(3), stateAfter(1))).toBe(
      null
    );
  });

  it("has no answer for an unknown origin, and says so with null", () => {
    expect(
      syncRetryBudgetRemainingMs(
        { kind: SyncRetryBudgetKind.Age, ageHorizonMs: ONE_DAY_MS },
        stateAfter(0, null)
      )
    ).toBe(null);
  });
});
