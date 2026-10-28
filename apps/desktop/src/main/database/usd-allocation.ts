/**
 * Largest-remainder allocation of USD money buckets to whole cents.
 *
 * Split out of `local-insights.ts` — which was over the file-size ceiling and
 * shrink-only at the time — because this is one self-contained responsibility
 * with no
 * dependency on the insights queries: given exact per-key dollar amounts, hand
 * back per-key amounts that are whole cents AND still sum to the intended total.
 * Independent per-key rounding cannot promise that, and every local money
 * breakdown (spend by model, spend by day, spend by session outcome) needs the
 * same promise, so they all share this one routine.
 */

import { nullableNumber, numberOrZero } from "./db-helpers.js";

export function allocateRoundedUsdValues(
  values: Readonly<Record<string, number>>,
  targetTotal?: number
): Record<string, number> {
  const entries = Object.entries(values).map(([key, value]) => {
    const exactCents = value * 100;
    const allocatedCents = Math.trunc(exactCents);
    return {
      allocatedCents,
      key,
      remainder: exactCents - allocatedCents,
      value,
    };
  });
  if (entries.length === 0) {
    return {};
  }

  const targetCents = Math.round((targetTotal ?? stableUsdSum(entries)) * 100);
  let remainingCents =
    targetCents - entries.reduce((sum, entry) => sum + entry.allocatedCents, 0);
  const direction = Math.sign(remainingCents);

  if (direction !== 0) {
    const candidates = entries
      .filter((entry) =>
        direction > 0 ? entry.remainder > 0 : entry.remainder < 0
      )
      .sort((a, b) => compareUsdRemainders(a, b, direction));
    const apportioned = Math.min(Math.abs(remainingCents), candidates.length);
    for (let index = 0; index < apportioned; index += 1) {
      candidates[index].allocatedCents += direction;
    }
    remainingCents -= direction * apportioned;
  }

  // A direct ungrouped SQLite SUM can differ from the grouped sums by more
  // than their ordinary fractional remainders because floating addition is
  // non-associative. Preserve the exact target deterministically in that rare
  // case without changing the response order.
  if (remainingCents !== 0) {
    const recipient = entries.reduce((largest, entry) =>
      compareUsdMagnitude(entry, largest) < 0 ? entry : largest
    );
    recipient.allocatedCents += remainingCents;
  }

  return Object.fromEntries(
    entries.map((entry) => [
      entry.key,
      normalizeUsdZero(entry.allocatedCents / 100),
    ])
  );
}

type UsdAllocationEntry = {
  allocatedCents: number;
  key: string;
  remainder: number;
  value: number;
};

function stableUsdSum(entries: readonly UsdAllocationEntry[]): number {
  return [...entries]
    .sort((a, b) => compareUsdKeys(a.key, b.key))
    .reduce((sum, entry) => sum + entry.value, 0);
}

function compareUsdRemainders(
  a: UsdAllocationEntry,
  b: UsdAllocationEntry,
  direction: number
): number {
  const difference =
    direction > 0 ? b.remainder - a.remainder : a.remainder - b.remainder;
  return difference || compareUsdKeys(a.key, b.key);
}

function compareUsdMagnitude(
  a: UsdAllocationEntry,
  b: UsdAllocationEntry
): number {
  return Math.abs(b.value) - Math.abs(a.value) || compareUsdKeys(a.key, b.key);
}

function compareUsdKeys(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function normalizeUsdZero(value: number): number {
  return value === 0 ? 0 : value;
}

/** One raw model-spend row as the Insights breakdown query projects it. */
export type ModelSpendRow = {
  model: string;
  value: number | bigint | string | null | undefined;
  total: number | bigint | string | null | undefined;
};

/**
 * ISS-7580: the model-spend breakdown's raw-row boundary — the one place the
 * Insights model buckets are sanitized before allocation, so a single corrupt
 * `cost_usd_estimated` cell cannot rewrite money that was never corrupt.
 *
 * The two arguments need DIFFERENT degradations, which is the whole reason this
 * is a named boundary rather than two inline coercions. A bucket degrades to 0:
 * a model whose spend we cannot read contributes nothing we can name. The
 * TARGET TOTAL must not, because `targetTotal` is what the allocator conserves
 * against — a 0 there sets `targetCents` to 0 and strips every good bucket of
 * the cents it had actually earned, which is a worse lie than the one bad
 * bucket. An unreadable total is UNKNOWN, so it degrades to `null` and the
 * allocator falls back to summing the sanitized buckets.
 *
 * That case is reachable, and by the OTHER spelling of a bad cell. Measured
 * against `node:sqlite`: `SUM` over a TEXT column applies numeric affinity, so
 * `"n/a"`-shaped text sums to 0 and never reaches JS as a string at all, while
 * one `"1e999"`-shaped cell makes BOTH its own bucket and the window total
 * `Infinity`. Only a bare, non-aggregate TEXT read hands JS the literal `"n/a"`.
 */
export function allocateModelSpendBuckets(
  rows: readonly ModelSpendRow[]
): Record<string, number> {
  return allocateRoundedUsdValues(
    Object.fromEntries(rows.map((row) => [row.model, numberOrZero(row.value)])),
    nullableNumber(rows[0]?.total) ?? undefined
  );
}
