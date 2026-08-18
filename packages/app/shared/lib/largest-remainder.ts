/**
 * The largest-remainder (Hamilton) allocation, hoisted so the two surfaces that
 * need it — per-row PERCENTAGES (`percent-shares.ts`) and per-row CENTS
 * (`reconciled-cost-cents.ts`) — share one implementation instead of two copies
 * that drift.
 *
 * Both callers are solving the same problem: a column of rounded parts that has
 * to add up to the whole it is presented as a decomposition of. Rounding each
 * part independently is what breaks that — three equal thirds render 33/33/33
 * (= 99), and five phase costs rounded to cents render $32.84 under a $32.86
 * header (ISS-4685, ISS-5000). Floor everything, then hand the leftover units to
 * the largest fractional remainders.
 */

/** Fractional remainders within this of each other count as tied. */
const REMAINDER_EPSILON = 1e-9;

/**
 * Whole units for `rawUnits`, summing to EXACTLY `targetUnits`.
 *
 * `rawUnits` are the unrounded parts already expressed in the target's unit
 * (percentage points, cents, …); `targetUnits` is the integer the column must
 * add up to. Every returned element is a non-negative integer.
 *
 * Ties go to the LARGER raw value — the conventional, stable choice, and shared
 * by both callers so a Cost column and the Cost % column beside it cannot break
 * the same tie differently for the same row.
 *
 * `targetUnits` does not have to equal the sum of `rawUnits`: a caller may head
 * its column with a rollup computed elsewhere. Both directions are handled — a
 * surplus is distributed round-robin (so a leftover larger than the row count is
 * fully allocated rather than truncated at one pass), and a deficit is reclaimed
 * from the smallest remainders first, never taking a row below zero. When the
 * rows cannot absorb the whole deficit (every row already at zero) the allocation
 * stops rather than looping.
 */
export function largestRemainderAllocate(
  rawUnits: readonly number[],
  targetUnits: number
): number[] {
  const safeUnits = rawUnits.map((value) =>
    Number.isFinite(value) && value > 0 ? value : 0
  );
  const result = safeUnits.map((value) => Math.floor(value));
  if (result.length === 0) {
    return result;
  }
  const floorSum = result.reduce((sum, units) => sum + units, 0);
  const leftover = Math.round(targetUnits) - floorSum;
  const largestRemainderFirst = safeUnits
    .map((value, index) => ({
      index,
      frac: value - Math.floor(value),
      value,
    }))
    .sort((a, b) => {
      const fracDelta = b.frac - a.frac;
      return Math.abs(fracDelta) > REMAINDER_EPSILON
        ? fracDelta
        : b.value - a.value;
    })
    .map((entry) => entry.index);

  if (leftover > 0) {
    distributeSurplus(result, largestRemainderFirst, leftover);
  } else if (leftover < 0) {
    reclaimDeficit(result, largestRemainderFirst, -leftover);
  }
  return result;
}

/**
 * Hand out `count` units, largest fractional remainder first, wrapping around
 * for as many passes as it takes. The wrap matters only when `count` exceeds the
 * row count — reachable when `targetUnits` is a rollup from elsewhere rather
 * than the sum of the parts — where a single pass would silently under-allocate
 * and leave the column short of the total it is supposed to match.
 */
function distributeSurplus(
  units: number[],
  orderByRemainderDesc: readonly number[],
  count: number
): void {
  const rows = orderByRemainderDesc.length;
  for (let given = 0; given < count; given += 1) {
    units[orderByRemainderDesc[given % rows]] += 1;
  }
}

/**
 * Take `count` units back, smallest fractional remainder first and never below
 * zero.
 *
 * Capping the demand at the rows' total capacity up front is what makes this
 * terminate: an impossible deficit is clamped instead of sweeping forever. Each
 * row gives up as much as it can in one go, so the whole reclaim costs at most
 * two passes over the rows regardless of how large the deficit is — the loop is
 * bounded by the ROW COUNT, not by the magnitude.
 *
 * The trade-off of taking a whole row at once is that it empties the
 * smallest-remainder rows rather than shaving every row evenly. That is
 * acceptable because no caller reaches this path today (both pass a `targetUnits`
 * derived from the same values), and a bounded, provably-terminating reclaim is
 * worth more here than a fairer distribution of a deficit that should not exist.
 */
function reclaimDeficit(
  units: number[],
  orderByRemainderDesc: readonly number[],
  count: number
): void {
  const smallestRemainderFirst = [...orderByRemainderDesc].reverse();
  const capacity = units.reduce((sum, value) => sum + value, 0);
  let remaining = Math.min(count, capacity);
  while (remaining > 0) {
    for (const index of smallestRemainderFirst) {
      if (remaining <= 0) {
        break;
      }
      // Take the whole row at once rather than one unit per sweep, so a large
      // deficit costs one pass instead of one pass per unit.
      const taken = Math.min(units[index], remaining);
      units[index] -= taken;
      remaining -= taken;
    }
  }
}
