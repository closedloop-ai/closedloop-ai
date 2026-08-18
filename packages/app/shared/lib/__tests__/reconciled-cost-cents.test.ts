import {
  reconcileDisplayedCostCents,
  toDisplayCents,
} from "@repo/app/shared/lib/reconciled-cost-cents";
import { describe, expect, it } from "vitest";

const CENTS = 100;

function sumCents(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + Math.round(value * CENTS), 0);
}

/**
 * The reconciled column, asserting it exists. `reconcileDisplayedCostCents`
 * returns null when the parts cannot be honestly reconciled (#4324 review), so
 * the happy-path cases below say so once here instead of coalescing at every
 * call and quietly asserting against an empty array.
 */
function reconciled(values: readonly number[], total: number): number[] {
  const result = reconcileDisplayedCostCents(values, total);
  if (result === null) {
    throw new Error("expected a reconciled column, received null");
  }
  return result;
}

describe("reconcileDisplayedCostCents (ISS-5000)", () => {
  it("makes the SES-78747 breakdown add up to its own header", () => {
    // The production values behind the finding: five phases whose independently
    // 2dp-rounded costs read $24.79 + $3.40 + $3.25 + $0.00 + $1.40 = $32.84,
    // under a header that (correctly) read $32.86.
    const phaseCosts = [24.7949, 3.4049, 3.2549, 0, 1.4049];
    const total = phaseCosts.reduce((sum, value) => sum + value, 0);

    const displayed = reconciled(phaseCosts, total);

    expect(sumCents(displayed)).toBe(Math.round(total * CENTS));
    // Without the fix this is 3284 against a 3286 header — the filed gap.
    expect(sumCents(displayed)).toBe(3286);
  });

  it("never lets the column drift from the total, at any row count", () => {
    for (let rows = 1; rows <= 12; rows += 1) {
      const values = Array.from(
        { length: rows },
        (_, index) => (index + 1) * 1.005 + 0.004
      );
      const total = values.reduce((sum, value) => sum + value, 0);
      expect(sumCents(reconciled(values, total))).toBe(
        Math.round(total * CENTS)
      );
    }
  });

  it("gives the leftover cent to the larger amount when remainders tie", () => {
    // Three exact thirds of a dollar: 33.33c each, one cent to hand out.
    const displayed = reconciled([1 / 3, 1 / 3, 1 / 3], 1);
    expect(sumCents(displayed)).toBe(100);
    expect(displayed.filter((value) => value === 0.34)).toHaveLength(1);
  });

  it("leaves already-exact cents untouched", () => {
    expect(reconcileDisplayedCostCents([1.5, 2.25, 0.25], 4)).toEqual([
      1.5, 2.25, 0.25,
    ]);
  });

  it("returns zeros for a TRUE zero total, but null when the total is not a number", () => {
    // A true zero is a real answer and stays a column of zeros. A NaN total is
    // "not computed" and must NOT be dressed up as $0.00 (#4324 review) — the
    // two are different facts and the caller has to be able to tell them apart.
    expect(reconcileDisplayedCostCents([0, 0], 0)).toEqual([0, 0]);
    expect(reconcileDisplayedCostCents([1, 2], Number.NaN)).toBeNull();
    expect(reconcileDisplayedCostCents([1, 2], -1)).toBeNull();
  });

  it("refuses to reconcile a negative or non-finite row instead of clamping it (wongk, #4324)", () => {
    // The filed case: [-1, 3] against a $2 total. Clamping rendered $0.00 and
    // $2.00 — it hid the corrupt phase behind a plausible zero AND silently
    // moved a real dollar onto the phase beside it. Null means "cannot
    // reconcile" and the caller falls back to its unreconciled rendering.
    expect(reconcileDisplayedCostCents([-1, 3], 2)).toBeNull();
    expect(reconcileDisplayedCostCents([Number.NaN, -5, 2], 2)).toBeNull();
    // A valid population still reconciles exactly.
    expect(sumCents(reconciled([1, 1], 2))).toBe(200);
  });

  it("reclaims cents, without going negative, when the total is BELOW the parts", () => {
    // Reachable for a caller heading the column with a rollup from elsewhere.
    // This is the DEFICIT branch: floors sum to 1000c against a 600c target.
    const displayed = reconciled([5, 5, 0], 6);
    expect(sumCents(displayed)).toBe(600);
    expect(displayed.every((value) => value >= 0)).toBe(true);
  });

  it("clamps a deficit larger than the rows can give back, instead of looping", () => {
    // Demand 500c back from rows holding 200c. The helper must stop at zero
    // rather than sweep forever or go negative.
    const displayed = reconciled([1, 1], 0.000_000_1);
    expect(displayed).toEqual([0, 0]);
  });

  it("distributes a SURPLUS larger than the row count instead of truncating it", () => {
    // The bug this pins: a single largest-remainder pass hands out at most one
    // cent per row, so a 998c leftover over 2 rows silently landed 2c and left
    // the column 996c short of the header it is supposed to match.
    expect(sumCents(reconciled([1, 1], 10))).toBe(1000);
    expect(sumCents(reconciled([0, 0, 0], 0.05))).toBe(5);
  });

  it("agrees with the currency formatter on a half-cent boundary", () => {
    // `Math.round` and Intl's 2dp rounding disagree on doubles sitting within a
    // hair of a half-cent. The header must be derived from `toDisplayCents` so a
    // one-cent split between it and the column cannot reappear.
    const total = 17.865;
    expect(
      Number(
        (toDisplayCents(total) / 100).toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      ) * 100
    ).toBe(toDisplayCents(total));
    expect(sumCents(reconciled([10.0, 7.865], total))).toBe(
      toDisplayCents(total)
    );
  });
});
