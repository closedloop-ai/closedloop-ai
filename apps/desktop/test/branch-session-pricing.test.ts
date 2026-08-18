import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { priceSyncedBranchSession } from "../src/main/branch/branch-session-pricing.js";
import { estimateTokenCost } from "../src/shared/token-cost.js";
import { syncedSession } from "./shared-branches-test-helpers.js";

describe("priceSyncedBranchSession", () => {
  test("returns null when the session has no priced usage", () => {
    assert.equal(
      priceSyncedBranchSession(
        syncedSession({ externalSessionId: "session-empty" })
      ),
      null
    );
  });

  test("preserves an authoritative stored zero without re-pricing", () => {
    const cost = priceSyncedBranchSession(
      syncedSession({
        externalSessionId: "session-stored",
        tokenUsageByModel: [
          {
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            estimatedCostUsd: 0,
            inputTokens: -1,
            model: "",
            outputTokens: 0,
          },
        ],
      })
    );

    assert.equal(cost, 0);
  });

  test("prices the one-hour cache-write subdivision through the shared engine", () => {
    const usage = {
      cacheReadTokens: 50,
      cacheWrite1hTokens: 80,
      cacheWriteTokens: 100,
      inputTokens: 1000,
      model: "claude-sonnet-4-5",
      outputTokens: 200,
    };
    const expected = estimateTokenCost({
      ...usage,
      observedAt: "2026-06-10T10:00:00.000Z",
    });
    assert.ok(expected);

    const cost = priceSyncedBranchSession(
      syncedSession({
        externalSessionId: "session-estimated",
        tokenUsageByModel: [usage],
      })
    );

    assert.equal(cost, expected.costUsd);
  });

  test("refuses to fabricate a price for malformed unpriced usage", () => {
    const cost = priceSyncedBranchSession(
      syncedSession({
        externalSessionId: "session-unpriced",
        tokenUsageByModel: [
          {
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            inputTokens: 10,
            model: "",
            outputTokens: 5,
          },
        ],
      })
    );

    assert.equal(cost, null);
  });
});
