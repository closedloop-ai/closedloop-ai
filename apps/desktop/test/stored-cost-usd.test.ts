import assert from "node:assert/strict";
import { MAX_AUTHORITATIVE_COST_USD } from "@repo/api/src/constants";
import { describe, test } from "vitest";
import {
  coerceStoredCostUsd,
  publishableStoredCostUsd,
} from "../src/main/database/stored-cost-usd.js";

/**
 * ISS-7229: the direct suite for the one place a stored `authoritative_cost_usd`
 * becomes a number.
 *
 * Nothing imported these two functions before. The incidental coverage they had
 * — through the sync payload and the re-sync heal — only ever reached the
 * `typeof value === "number"` branch, because that is the shape a seeded fixture
 * produces. Every guard below therefore survived as untested code inside a
 * module whose whole job is to refuse a fabricated cost:
 *
 *   - delete the `value.trim() !== ""` test and `Number("")` ships a confident
 *     `authoritativeCostUsd: 0` — "Claude reported $0.00" for a session that
 *     reported nothing at all, which the column's NULL semantics exist to keep
 *     apart from a genuine reported zero;
 *   - delete the `costUsd < 0` refusal and a negative cost reaches the wire.
 *
 * A UNIT SUITE IS THE RIGHT SLICE HERE, and this is the trust-boundary carveout
 * rather than a violation of "do not test type-forbidden inputs": the parameter
 * is `unknown` by design, because the value arrives from `$queryRawUnsafe`,
 * where the driver — not the type system — decides what shape a column
 * materializes as. That is exactly the boundary the types do not constrain.
 */

/** A `Decimal`-shaped value, which is what the raw path actually hands back. */
function decimalLike(value: number): { toNumber: () => number } {
  return { toNumber: () => value };
}

describe("coerceStoredCostUsd (ISS-7229)", () => {
  test("reads a plain number", () => {
    assert.equal(coerceStoredCostUsd(12.5), 12.5);
    assert.equal(coerceStoredCostUsd(0), 0);
  });

  test("reads the Decimal the raw-query path actually returns", () => {
    // The shape that made this module shared in the first place: an earlier
    // reader tested `typeof stored === "number"` and reported every backfilled
    // session unusable.
    assert.equal(coerceStoredCostUsd(decimalLike(1502.1)), 1502.1);
  });

  test("refuses a Decimal whose toNumber does not answer a finite number", () => {
    assert.equal(coerceStoredCostUsd({ toNumber: () => Number.NaN }), null);
    assert.equal(coerceStoredCostUsd({ toNumber: () => "1.5" }), null);
  });

  test("reads a numeric string, and REFUSES a blank one", () => {
    // The named survivor. `Number("")` is `0`, not `NaN`, so a blank column
    // read without the emptiness test becomes a measured "Claude charged
    // nothing" — a fabricated figure, which is worse than a missing one.
    assert.equal(coerceStoredCostUsd("3.25"), 3.25);
    assert.equal(coerceStoredCostUsd(""), null);
    assert.equal(coerceStoredCostUsd("   "), null);
    assert.equal(coerceStoredCostUsd("not-a-cost"), null);
  });

  test("reads a bigint", () => {
    assert.equal(coerceStoredCostUsd(7n), 7);
  });

  test("refuses a non-finite number rather than passing it through", () => {
    assert.equal(coerceStoredCostUsd(Number.NaN), null);
    assert.equal(coerceStoredCostUsd(Number.POSITIVE_INFINITY), null);
  });

  test("refuses every shape it does not recognise", () => {
    for (const value of [null, undefined, true, {}, [], new Date()]) {
      assert.equal(
        coerceStoredCostUsd(value),
        null,
        `unrecognised shape must not coerce: ${String(value)}`
      );
    }
  });
});

describe("publishableStoredCostUsd (ISS-7229)", () => {
  test("passes a storable figure through, including a reported zero", () => {
    assert.equal(publishableStoredCostUsd(12.5), 12.5);
    // Claude charging nothing is a MEASUREMENT and must survive both policy
    // tests; a truthiness guard here would erase it.
    assert.equal(publishableStoredCostUsd(0), 0);
    assert.equal(publishableStoredCostUsd(decimalLike(0)), 0);
  });

  test("REFUSES a negative cost", () => {
    // The other named survivor. A cost is never negative, and the refusal is
    // policy rather than range — `coerceStoredCostUsd` deliberately admits it,
    // so nothing upstream of this line stops it reaching the wire.
    assert.equal(publishableStoredCostUsd(-1), null);
    assert.equal(publishableStoredCostUsd(-0.000_001), null);
    assert.equal(publishableStoredCostUsd(decimalLike(-1)), null);
  });

  test("REFUSES a figure the cloud column could not hold", () => {
    // The bound is the cloud's `Decimal(14, 6)`. Refusing at the producer keeps
    // an unpublishable cost out of the payload rather than leaving the receiver
    // to drop it — and the value is checked AFTER canonicalization, so the
    // check and the write cannot disagree in the seventh decimal.
    assert.equal(publishableStoredCostUsd(MAX_AUTHORITATIVE_COST_USD), null);
    assert.equal(publishableStoredCostUsd(1e100), null);
    // Just under the ceiling, so the guard cannot pass by refusing everything.
    assert.equal(publishableStoredCostUsd(99_999_999), 99_999_999);
  });

  test("ADMITS the figure that rounds up past the ceiling, which is deliberate", () => {
    // The bound is decided on the CANONICALIZED figure, not the raw double:
    // `(99999999.9999995).toFixed(6)` is `99999999.999999`, which fits. So this
    // value passes here — and the cloud writer must then send that same
    // canonicalized string, because the raw double rounds half-up to nine
    // integer digits, which `numeric(14, 6)` refuses. That is the pairing
    // `toAuthoritativeCostPatch` closes on the ingest side; pinned here so a
    // future "tighten the guard" change cannot silently make the two disagree
    // in the other direction.
    assert.equal(
      publishableStoredCostUsd(99_999_999.999_999_5),
      99_999_999.999_999_5
    );
  });

  test("refuses what the coercion already refused", () => {
    assert.equal(publishableStoredCostUsd(""), null);
    assert.equal(publishableStoredCostUsd(null), null);
    assert.equal(publishableStoredCostUsd(Number.NaN), null);
  });
});
