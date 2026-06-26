/**
 * @file cost-math.test.ts
 * @description Unit tests for the integer micro-cents money math used by nightly
 * cost reconciliation (FEA-1435), src/main/cost-math.ts.
 *
 * The reviewed invariant is that money is converted ONCE to integer micro-cents
 * at the boundary and all aggregation/drift is then EXACT integer arithmetic
 * (no float accumulation), with implausibly large inputs failing loudly rather
 * than silently losing precision. These tests pin the conversion factors, the
 * decimal-string parsing precision (Anthropic's cost_report shape), exact integer
 * summation, the safe-integer guards, and the signed drift / null-percentage
 * semantics.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  centsToMicroCents,
  computeDrift,
  MICRO_CENTS_PER_CENT,
  MICRO_CENTS_PER_USD,
  microCentsToUsd,
  parseDecimalCentsToMicroCents,
  sumMicroCents,
  usdToMicroCents,
} from "../src/main/cost-math.js";

test("conversion factors are the documented constants", () => {
  assert.equal(MICRO_CENTS_PER_CENT, 10_000);
  assert.equal(MICRO_CENTS_PER_USD, 1_000_000);
  // 1 USD = 100 cents and both express the same micro-cent.
  assert.equal(MICRO_CENTS_PER_USD, MICRO_CENTS_PER_CENT * 100);
});

test("usdToMicroCents rounds to integer micro-cents", () => {
  assert.equal(usdToMicroCents(0), 0);
  assert.equal(usdToMicroCents(1), 1_000_000);
  assert.equal(usdToMicroCents(0.000_001), 1); // one micro-cent
  assert.equal(usdToMicroCents(12.34), 12_340_000);
  // Half-up rounding at the micro-cent boundary.
  assert.equal(usdToMicroCents(0.000_000_5), 1);
  assert.equal(usdToMicroCents(0.000_000_4), 0);
  assert.throws(() => usdToMicroCents(Number.NaN), /non-finite/);
  assert.throws(() => usdToMicroCents(Number.POSITIVE_INFINITY), /non-finite/);
});

test("centsToMicroCents scales numeric cents", () => {
  assert.equal(centsToMicroCents(0), 0);
  assert.equal(centsToMicroCents(1), 10_000);
  assert.equal(centsToMicroCents(123.4567), 1_234_567);
  assert.throws(() => centsToMicroCents(Number.NaN), /non-finite/);
});

test("parseDecimalCentsToMicroCents parses Anthropic decimal-string cents exactly", () => {
  assert.equal(parseDecimalCentsToMicroCents("0"), 0);
  assert.equal(parseDecimalCentsToMicroCents("1"), 10_000);
  assert.equal(parseDecimalCentsToMicroCents("12.3456"), 123_456);
  // 5th fractional digit rounds half-up and carries into the cent.
  assert.equal(parseDecimalCentsToMicroCents("0.99995"), 10_000);
  assert.equal(parseDecimalCentsToMicroCents("0.99994"), 9999);
  // Trailing precision beyond micro-cents is truncated after the rounding digit.
  assert.equal(parseDecimalCentsToMicroCents("12.345678901"), 123_457);
  // Whitespace and signs.
  assert.equal(parseDecimalCentsToMicroCents("  42.5  "), 425_000);
  assert.equal(parseDecimalCentsToMicroCents("-3.0"), -30_000);
  // Large value stays exact (no float drift): $12,345.6789 = 1,234,567.89 cents.
  assert.equal(parseDecimalCentsToMicroCents("1234567.89"), 12_345_678_900);
  // Rejects non-decimal junk.
  assert.throws(() => parseDecimalCentsToMicroCents("12.3.4"), /decimal cents/);
  assert.throws(() => parseDecimalCentsToMicroCents("abc"), /decimal cents/);
  assert.throws(() => parseDecimalCentsToMicroCents(""), /decimal cents/);
});

test("microCentsToUsd is the inverse of usdToMicroCents for representable amounts", () => {
  assert.equal(microCentsToUsd(1_000_000), 1);
  assert.equal(microCentsToUsd(12_340_000), 12.34);
  assert.equal(microCentsToUsd(0), 0);
  for (const usd of [0, 0.5, 1.23, 99.99, 12_345.6789]) {
    assert.equal(microCentsToUsd(usdToMicroCents(usd)), usd);
  }
  assert.throws(() => microCentsToUsd(1.5), /non-safe-integer/);
});

test("sumMicroCents adds with exact integer arithmetic", () => {
  assert.equal(sumMicroCents([]), 0);
  assert.equal(sumMicroCents([1, 2, 3]), 6);
  assert.equal(sumMicroCents([10_000, 20_000, 30_000]), 60_000);
  assert.equal(sumMicroCents([-5, 5]), 0);
  // A float sum of 0.1+0.2 famously != 0.3; the micro-cent integers are exact.
  const a = usdToMicroCents(0.1);
  const b = usdToMicroCents(0.2);
  assert.equal(sumMicroCents([a, b]), usdToMicroCents(0.3));
  assert.throws(() => sumMicroCents([1.5]), /non-safe-integer/);
  assert.throws(
    () => sumMicroCents([Number.MAX_SAFE_INTEGER, 1]),
    /running total/
  );
});

test("computeDrift returns signed micro-cent drift and percentage", () => {
  // Over-estimate: local 110 vs vendor 100 → +10, +10%.
  assert.deepEqual(computeDrift(110, 100), {
    driftMicroCents: 10,
    driftPct: 10,
  });
  // Under-estimate: local 90 vs vendor 100 → −10, −10%.
  assert.deepEqual(computeDrift(90, 100), {
    driftMicroCents: -10,
    driftPct: -10,
  });
  // Exact match.
  assert.deepEqual(computeDrift(100, 100), {
    driftMicroCents: 0,
    driftPct: 0,
  });
});

test("computeDrift returns null percentage when the vendor billed nothing", () => {
  // vendor === 0: percentage is undefined (division by zero) → null, not 0/Inf.
  assert.deepEqual(computeDrift(50_000, 0), {
    driftMicroCents: 50_000,
    driftPct: null,
  });
  assert.deepEqual(computeDrift(0, 0), {
    driftMicroCents: 0,
    driftPct: null,
  });
});

test("computeDrift rejects non-integer inputs", () => {
  assert.throws(() => computeDrift(1.5, 100), /non-safe-integer/);
  assert.throws(() => computeDrift(100, 2.5), /non-safe-integer/);
});
