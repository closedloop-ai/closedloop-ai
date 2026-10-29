/**
 * @file db-helpers-number-or-zero.test.ts
 * @description Unit tests for `numberOrZero` in db-helpers.ts (FEA-3131), the
 * single source of truth for the null-to-zero numeric coercion that
 * local-insights.ts (as `num`) and shared-agent-components-api.ts (as
 * `toNumber`) each previously hand-rolled. Both consumers now share one body, so
 * these lock the contract they rely on — null/undefined map to 0, Prisma's raw
 * `bigint` aggregates and numeric strings normalize to a JS number, finite
 * numbers pass through bit-identically (including `-0`), and anything that
 * carries no number at all reads 0 (ISS-7580) — and fail if a future edit
 * narrows any branch out from under either call site.
 *
 * They also cover `nullableNumber`, the null-degrading twin: same module, same
 * input union, same finite check, so the pair cannot drift apart.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  nullableNumber,
  numberOrZero,
} from "../src/main/database/db-helpers.js";

test("numberOrZero maps null and undefined to 0", () => {
  assert.equal(numberOrZero(null), 0);
  assert.equal(numberOrZero(undefined), 0);
});

test("numberOrZero converts bigint aggregates to a JS number", () => {
  // SQLite COUNT/SUM surface as `bigint` through Prisma's raw read path.
  for (const [input, expected] of [
    [0n, 0],
    [42n, 42],
    [-7n, -7],
    [BigInt(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ] as const) {
    assert.equal(numberOrZero(input), expected);
  }
});

test("numberOrZero passes finite numbers through unchanged", () => {
  // `Object.is` (not `equal`) so a `-0`→`0` drift would be caught.
  for (const input of [0, -0, 1, -3.5, Number.MAX_SAFE_INTEGER]) {
    assert.ok(
      Object.is(numberOrZero(input), input),
      `expected ${String(input)} to pass through verbatim`
    );
  }
});

/**
 * ISS-7580. This case previously asserted the OPPOSITE — that `NaN` and
 * `Infinity` passed through verbatim alongside the finite numbers. The
 * expectation changed because the behavior did, deliberately: a helper named
 * `numberOrZero` handing a caller a `NaN` breaks its own contract, and the
 * damage downstream is silent rather than visible (see the ISS-7580 note on the
 * helper, and the money-breakdown regressions in
 * usd-allocation-model-spend-cells.test.ts).
 */
test("numberOrZero maps non-finite numbers to 0", () => {
  for (const input of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    assert.ok(
      Object.is(numberOrZero(input), 0),
      `expected ${String(input)} to degrade to 0`
    );
  }
});

test("numberOrZero converts numeric strings to a number", () => {
  for (const [input, expected] of [
    ["0", 0],
    ["42", 42],
    ["-3.5", -3.5],
    ["", 0], // Number("") is 0 — an empty cell reads as zero, not NaN.
  ] as const) {
    assert.equal(numberOrZero(input), expected);
  }
});

// ISS-7580: several call sites alias this as `num` over `$queryRawUnsafe` rows
// whose columns are unconstrained TEXT, so "" is far from the only non-number a
// cell can hold. `"1e999"` is the overflow spelling — it parses, to Infinity.
test("numberOrZero maps a non-numeric string to 0", () => {
  for (const input of ["n/a", "abc", "12abc", "NaN", "1.2.3", "--3", "1e999"]) {
    assert.ok(
      Object.is(numberOrZero(input), 0),
      `expected ${input} to degrade to 0`
    );
  }
});

// ISS-7580: the twin exists so a caller whose figure would LIE as a zero has
// somewhere to go. Pinned in the same file as `numberOrZero` because the pair's
// only difference is the degradation — every other branch must stay identical,
// and a drift between them is the bug this coupling exists to catch.
test("nullableNumber degrades to null over the same input union", () => {
  assert.equal(nullableNumber(null), null);
  assert.equal(nullableNumber(undefined), null);
  for (const input of [
    "n/a",
    "abc",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    assert.equal(
      nullableNumber(input),
      null,
      `expected ${String(input)} to degrade to null, not 0`
    );
  }
  // Everything numeric-ish resolves exactly as `numberOrZero` does.
  for (const [input, expected] of [
    [0, 0],
    [-3.5, -3.5],
    [42n, 42],
    ["-3.5", -3.5],
    ["", 0],
  ] as const) {
    assert.equal(nullableNumber(input), expected);
    assert.equal(numberOrZero(input), expected);
  }
});
