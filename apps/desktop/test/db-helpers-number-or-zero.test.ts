/**
 * @file db-helpers-number-or-zero.test.ts
 * @description Unit tests for `numberOrZero` in db-helpers.ts (FEA-3131), the
 * single source of truth for the null-to-zero numeric coercion that
 * local-insights.ts (as `num`) and shared-agent-components-api.ts (as
 * `toNumber`) each previously hand-rolled. Both consumers now share one body, so
 * these lock the contract they rely on — null/undefined map to 0, Prisma's raw
 * `bigint` aggregates and numeric strings normalize to a JS number, and existing
 * numbers pass through bit-identically (including `NaN` and `-0`) — and fail if
 * a future edit narrows any branch out from under either call site.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { numberOrZero } from "../src/main/database/db-helpers.js";

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

test("numberOrZero passes existing numbers through unchanged", () => {
  // `Object.is` (not `equal`) so a `-0`→`0` or `NaN` drift would be caught.
  for (const input of [0, -0, 1, -3.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.ok(
      Object.is(numberOrZero(input), input),
      `expected ${String(input)} to pass through verbatim`
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
