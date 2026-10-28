/**
 * @file usd-allocation-model-spend-cells.test.ts
 * @description ISS-7580. Pins what the Insights model-spend breakdown does with
 * a `cost_usd_estimated` cell it cannot read, at `allocateModelSpendBuckets` —
 * the boundary `computeAgents` hands its raw rows to.
 *
 * A focused sibling suite rather than more lines in
 * `local-insights-contract.test.ts`, which is in `biome.jsonc`'s grandfathered
 * ledger and therefore shrink-only (`apps/desktop/test/AGENTS.md`).
 *
 * The two spellings of a bad cell reach JS DIFFERENTLY, which is why both are
 * here. Measured against `node:sqlite`, `SUM` over a TEXT column applies
 * numeric affinity: `"n/a"` sums to 0 and never arrives as a string, while
 * `"1e999"` arrives as `Infinity` in BOTH its own bucket and the window total.
 * Only a bare, non-aggregate read hands JS the literal `"n/a"`.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  allocateModelSpendBuckets,
  allocateRoundedUsdValues,
} from "../src/main/database/usd-allocation.js";

// $0.004 + $0.004 is $0.008, one whole cent once allocated, and
// largest-remainder hands a tie to the alphabetically first key. So a run that
// conserves the good models' money reads `opus: 0.01`, and one that lost it
// reads `opus: 0` — the two outcomes are one assertion apart.
const GOOD_MODEL_SPEND_USD = 0.004;

test("ISS-7580: a non-numeric cell zeroes its own bucket and no other", () => {
  // The literal `"n/a"` shape — what a bare TEXT read yields. Before ISS-7580
  // `numberOrZero("n/a")` was NaN, which made targetCents and remainingCents
  // NaN: the apportion loop never ran (`Math.min(Math.abs(NaN), …)` is NaN) so
  // `opus` silently lost the cent it had earned, and the remainder fallback
  // then added NaN to `haiku`. The card rendered `{ opus: 0, sonnet: 0,
  // haiku: NaN }` — one visibly broken bucket beside plausible figures that no
  // longer summed to anything.
  assert.deepEqual(
    allocateModelSpendBuckets([
      { model: "opus", value: GOOD_MODEL_SPEND_USD, total: 0.008 },
      { model: "sonnet", value: GOOD_MODEL_SPEND_USD, total: 0.008 },
      { model: "haiku", value: "n/a", total: 0.008 },
    ]),
    { opus: 0.01, sonnet: 0, haiku: 0 }
  );
});

test("ISS-7580: an unreadable window total falls back to the sanitized buckets", () => {
  // The `"1e999"` shape. SQLite gives the corrupt row's bucket AND the window
  // total `Infinity`, so both arguments are poisoned at once. Degrading the
  // total to 0 like a bucket would set targetCents to 0 and strip `opus` of the
  // cent it really earned — a quieter lie than the bad bucket itself. The total
  // degrades to unknown instead, and the allocator conserves against the
  // sanitized buckets' own sum.
  assert.deepEqual(
    allocateModelSpendBuckets([
      {
        model: "opus",
        value: GOOD_MODEL_SPEND_USD,
        total: Number.POSITIVE_INFINITY,
      },
      {
        model: "sonnet",
        value: GOOD_MODEL_SPEND_USD,
        total: Number.POSITIVE_INFINITY,
      },
      {
        model: "haiku",
        value: Number.POSITIVE_INFINITY,
        total: Number.POSITIVE_INFINITY,
      },
    ]),
    { opus: 0.01, sonnet: 0, haiku: 0 }
  );
});

test("ISS-7580: a readable total is still the conservation target", () => {
  // The fallback must not swallow the reason `targetTotal` exists: a direct
  // ungrouped SUM can legitimately differ from the grouped sums (floating
  // addition is not associative), and that difference is what the allocator is
  // told to preserve. A total of $0.03 over two $0.004 buckets is the same
  // over-target case `local-insights-contract.test.ts` pins on the allocator
  // itself, driven here through the sanitizing boundary.
  assert.deepEqual(
    allocateModelSpendBuckets([
      { model: "zeta", value: GOOD_MODEL_SPEND_USD, total: 0.03 },
      { model: "alpha", value: GOOD_MODEL_SPEND_USD, total: 0.03 },
    ]),
    { zeta: 0.01, alpha: 0.02 }
  );
  // Reading the total off row 0 is the production shape, and every row carries
  // the same CROSS JOINed value — so the boundary must agree with a direct call
  // passing that value explicitly.
  assert.deepEqual(
    allocateModelSpendBuckets([
      { model: "zeta", value: GOOD_MODEL_SPEND_USD, total: 0.03 },
      { model: "alpha", value: GOOD_MODEL_SPEND_USD, total: 0.03 },
    ]),
    allocateRoundedUsdValues(
      { zeta: GOOD_MODEL_SPEND_USD, alpha: GOOD_MODEL_SPEND_USD },
      0.03
    )
  );
});

test("ISS-7580: bigint and numeric-string cells allocate as their numbers", () => {
  // Prisma's raw read path surfaces SQLite aggregates as `bigint`, and a REAL
  // column can arrive as a numeric string — neither is a corrupt cell, and
  // neither may be sanitized away.
  assert.deepEqual(
    allocateModelSpendBuckets([
      { model: "opus", value: "1.25", total: 3n },
      { model: "sonnet", value: 1.75, total: 3n },
    ]),
    { opus: 1.25, sonnet: 1.75 }
  );
});

test("ISS-7580: no rows allocates nothing rather than an empty-total zero", () => {
  assert.deepEqual(allocateModelSpendBuckets([]), {});
});
