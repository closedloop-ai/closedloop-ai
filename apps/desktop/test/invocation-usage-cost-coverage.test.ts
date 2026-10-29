/**
 * @file invocation-usage-cost-coverage.test.ts
 * @description ISS-8730 coverage pass for `src/main/cost/invocation-usage-cost.ts`.
 * Pins CURRENT behavior of the two exported cost-computation helpers —
 * `areInvocationUsageCountsValid` (the persistence gate) and
 * `invocationEstimatedCostUsd` (per-request-sum vs whole-fold pricing) —
 * across zero-cost, undefined-value, and reconciliation edge cases. Does not
 * change or "fix" the source; a surprising branch is pinned with a comment,
 * not altered.
 */
import assert from "node:assert/strict";
import type {
  NormalizedComponentUsage,
  NormalizedTokenRecord,
} from "@repo/lib/harness/types";
import { describe, test } from "vitest";
import {
  areInvocationUsageCountsValid,
  invocationEstimatedCostUsd,
} from "../src/main/cost/invocation-usage-cost.js";
import { estimateTokenCost } from "../src/shared/token-cost.js";

const AT = "2026-08-19T09:00:00.000Z";
const SESSION_ID = "iss8730-session";
/** Real, published-pricing model ids already relied on elsewhere in this suite. */
const PRICED_MODEL = "claude-opus-4-1";
const OTHER_PRICED_MODEL = "claude-sonnet-4-5";
/** A model id genai-prices cannot match — triggers the ISS-7762 fallback tier. */
const UNPRICEABLE_MODEL = "claude-sonnet-4-99-not-in-the-table";

function usage(
  overrides: Partial<NormalizedComponentUsage> = {}
): NormalizedComponentUsage {
  return {
    model: PRICED_MODEL,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

function record(
  overrides: Partial<NormalizedTokenRecord> = {}
): NormalizedTokenRecord {
  return {
    timestamp: AT,
    model: PRICED_MODEL,
    input: 50,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    ...overrides,
  };
}

describe("areInvocationUsageCountsValid", () => {
  test("accepts an all-zero-count usage row — zero is a measured value, not corruption", () => {
    assert.equal(
      areInvocationUsageCountsValid(
        usage({
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        })
      ),
      true
    );
  });

  test("rejects a negative token count", () => {
    assert.equal(
      areInvocationUsageCountsValid(usage({ inputTokens: -1 })),
      false
    );
  });

  test("rejects a non-finite token count (NaN and Infinity)", () => {
    assert.equal(
      areInvocationUsageCountsValid(usage({ outputTokens: Number.NaN })),
      false
    );
    assert.equal(
      areInvocationUsageCountsValid(
        usage({ cacheReadTokens: Number.POSITIVE_INFINITY })
      ),
      false
    );
  });

  test("count validity does not depend on the model — a null model with clean counts still passes", () => {
    // Pinning current behavior: areInvocationUsageCountsValid only gates the
    // four token counts (via areTokenCountsValid); usage.model never enters
    // that check. A null/mixed model is therefore VALID here even though it
    // later prices as null in invocationEstimatedCostUsd below — validity and
    // priceability are two separate gates in this module.
    assert.equal(areInvocationUsageCountsValid(usage({ model: null })), true);
  });
});

describe("invocationEstimatedCostUsd — folded pricing (no usageRecords)", () => {
  test("prices an all-zero-token invocation at exactly $0, never null", () => {
    const cost = invocationEstimatedCostUsd({
      usage: usage({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
      invokedAt: AT,
      sessionId: SESSION_ID,
    });
    assert.equal(cost, 0);
  });

  test("returns null when usage.model is null, even with otherwise-valid counts", () => {
    const cost = invocationEstimatedCostUsd({
      usage: usage({ model: null }),
      invokedAt: AT,
      sessionId: SESSION_ID,
    });
    assert.equal(cost, null);
  });

  test("returns null for an unpriceable model — never a guessed floor (ISS-7762)", () => {
    const cost = invocationEstimatedCostUsd({
      usage: usage({ model: UNPRICEABLE_MODEL }),
      invokedAt: AT,
      sessionId: SESSION_ID,
    });
    assert.equal(cost, null);
  });

  test("invokedAt: null still prices (falls back to latest pricing)", () => {
    const cost = invocationEstimatedCostUsd({
      usage: usage(),
      invokedAt: null,
      sessionId: SESSION_ID,
    });
    assert.equal(typeof cost, "number");
    assert.ok(
      (cost ?? 0) > 0,
      "measured tokens on a priced model must not cost 0"
    );
  });

  test("an all-one-hour cacheWriteTtl bucket costs 1.6x the same bucket priced at the default five-minute rate", () => {
    const CACHE_WRITE_ONLY_TOKENS = 1_000_000;
    const ONE_HOUR_OVER_FIVE_MINUTE_RATIO = 1.6;
    const base = usage({
      model: OTHER_PRICED_MODEL,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: CACHE_WRITE_ONLY_TOKENS,
    });

    const fiveMinute = invocationEstimatedCostUsd({
      usage: base,
      invokedAt: AT,
      sessionId: SESSION_ID,
    });
    const oneHour = invocationEstimatedCostUsd({
      usage: {
        ...base,
        cacheWriteTtl: { fiveM: 0, oneH: CACHE_WRITE_ONLY_TOKENS },
      },
      invokedAt: AT,
      sessionId: SESSION_ID,
    });

    assert.equal(typeof fiveMinute, "number");
    assert.equal(typeof oneHour, "number");
    const expected = (fiveMinute ?? 0) * ONE_HOUR_OVER_FIVE_MINUTE_RATIO;
    assert.ok(
      Math.abs((oneHour ?? 0) - expected) < 1e-9,
      `expected ${expected}, got ${oneHour}`
    );
  });
});

describe("invocationEstimatedCostUsd — per-request pricing (usageRecords present)", () => {
  test("sums per-request prices when records reconcile with the usage totals", () => {
    const records: NormalizedTokenRecord[] = [
      record({ model: PRICED_MODEL, input: 60, output: 12 }),
      record({ model: OTHER_PRICED_MODEL, input: 40, output: 8 }),
    ];
    const totalUsage = usage({
      model: null,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    const cost = invocationEstimatedCostUsd({
      usage: totalUsage,
      usageRecords: records,
      invokedAt: AT,
      sessionId: SESSION_ID,
    });

    const first = estimateTokenCost({
      model: PRICED_MODEL,
      inputTokens: 60,
      outputTokens: 12,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      observedAt: AT,
    });
    const second = estimateTokenCost({
      model: OTHER_PRICED_MODEL,
      inputTokens: 40,
      outputTokens: 8,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      observedAt: AT,
    });
    assert.equal(typeof first?.costUsd, "number");
    assert.equal(typeof second?.costUsd, "number");
    // Float-sum tolerance, matching the ratio-comparison convention used
    // elsewhere in this suite (component-invocation-subagent-usage-cost.test.ts).
    assert.ok(
      Math.abs((cost ?? 0) - ((first?.costUsd ?? 0) + (second?.costUsd ?? 0))) <
        1e-9,
      `expected the sum of both per-request prices, got ${cost}`
    );
  });

  test("returns null when one of several reconciled records cannot be priced — it does NOT fall back to folded pricing", () => {
    // Pinning current behavior: sumPerRequestCostUsd returns a DEFINED `null`
    // (not `undefined`) the moment one record in a reconciled set can't be
    // priced, and invocationEstimatedCostUsd treats any defined result —
    // including null — as final (`perRequest !== undefined`). The whole-fold
    // price is never consulted here, even though usage.model is null and
    // could not have been folded anyway.
    const records: NormalizedTokenRecord[] = [
      record({ model: PRICED_MODEL, input: 60, output: 12 }),
      record({ model: UNPRICEABLE_MODEL, input: 40, output: 8 }),
    ];
    const totalUsage = usage({
      model: null,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    const cost = invocationEstimatedCostUsd({
      usage: totalUsage,
      usageRecords: records,
      invokedAt: AT,
      sessionId: SESSION_ID,
    });
    assert.equal(cost, null);
  });

  test("falls back to folded pricing when records do not reconcile with the usage totals", () => {
    const mismatchedRecords: NormalizedTokenRecord[] = [
      record({ model: PRICED_MODEL, input: 999, output: 999 }),
    ];
    const totalUsage = usage({
      model: PRICED_MODEL,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    const withMismatchedRecords = invocationEstimatedCostUsd({
      usage: totalUsage,
      usageRecords: mismatchedRecords,
      invokedAt: AT,
      sessionId: SESSION_ID,
    });
    const withNoRecords = invocationEstimatedCostUsd({
      usage: totalUsage,
      invokedAt: AT,
      sessionId: SESSION_ID,
    });

    // A record set that does not sum to `usage` is priced exactly as if it had
    // never been supplied — same whole-fold price either way.
    assert.equal(withMismatchedRecords, withNoRecords);
    assert.equal(typeof withMismatchedRecords, "number");
  });

  test("an empty usageRecords array is treated the same as no records at all", () => {
    const totalUsage = usage();
    const withEmptyArray = invocationEstimatedCostUsd({
      usage: totalUsage,
      usageRecords: [],
      invokedAt: AT,
      sessionId: SESSION_ID,
    });
    const withNoRecords = invocationEstimatedCostUsd({
      usage: totalUsage,
      invokedAt: AT,
      sessionId: SESSION_ID,
    });
    assert.equal(withEmptyArray, withNoRecords);
  });

  test("a cacheWriteTtl split on the reconciled records is summed into the per-request total", () => {
    const cacheWriteRecords: NormalizedTokenRecord[] = [
      record({
        model: PRICED_MODEL,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 500_000,
        cacheWriteTtl: { fiveM: 0, oneH: 500_000 },
      }),
    ];
    const totalUsage = usage({
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 500_000,
      cacheWriteTtl: { fiveM: 0, oneH: 500_000 },
    });

    const cost = invocationEstimatedCostUsd({
      usage: totalUsage,
      usageRecords: cacheWriteRecords,
      invokedAt: AT,
      sessionId: SESSION_ID,
    });
    const expected = estimateTokenCost({
      model: PRICED_MODEL,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 500_000,
      cacheWrite1hTokens: 500_000,
      observedAt: AT,
    });
    assert.equal(typeof expected?.costUsd, "number");
    assert.ok(
      Math.abs((cost ?? 0) - (expected?.costUsd ?? 0)) < 1e-9,
      `expected ${expected?.costUsd}, got ${cost}`
    );
  });
});
