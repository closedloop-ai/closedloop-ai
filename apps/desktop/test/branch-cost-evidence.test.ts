import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  aggregateBranchCostCompleteness,
  BranchCostCompleteness,
  BranchCostCompletenessReason,
} from "@repo/api/src/types/branch-usage.js";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenSourceIdentityAvailability,
} from "@repo/api/src/types/token-cost-provenance.js";
import { BRANCH_COST_COMPLETENESS_PARITY_CASES } from "@repo/lib/branches/__tests__/cost-completeness-parity-fixture.js";
import { buildDesktopBranchCostEvidence } from "../src/main/branch/branch-cost-evidence.js";
import type { BranchUsageTokenRow } from "../src/main/database/branch-reads.js";

describe("Desktop Branch cost evidence", () => {
  test("projects complete mixed-lane persisted evidence", () => {
    const event = eventRow("session-1", 3);
    const result = fold([tokenRow("session-1", 3)], [event], [event], false);

    assert.deepEqual(result, {
      completeness: BranchCostCompleteness.Complete,
      subtotalUsd: 3,
      lanes: { subscriptionEquivalentCost: 1, apiEstimatedCost: 2 },
    });
  });

  test("marks bounded null or malformed event timestamps incomplete", () => {
    const valid = eventRow("session-1", 3);
    const invalid = { ...eventRow("session-1", 2), createdAt: null };

    assert.deepEqual(fold([], [], [invalid], true), {
      completeness: BranchCostCompleteness.Unavailable,
      reason: BranchCostCompletenessReason.CoverageIncomplete,
    });
    assert.deepEqual(fold([], [valid], [valid, invalid], true), {
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.CoverageIncomplete,
      subtotalUsd: 3,
      lanes: { subscriptionEquivalentCost: 1, apiEstimatedCost: 2 },
    });
    const corrupt = { ...invalid, tokenCountsInvalid: true as const };
    assert.deepEqual(fold([], [], [corrupt], true), {
      completeness: BranchCostCompleteness.Unavailable,
      reason: BranchCostCompletenessReason.Malformed,
    });
    assert.deepEqual(fold([], [valid], [valid, corrupt], true), {
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.Malformed,
      subtotalUsd: 3,
      lanes: { subscriptionEquivalentCost: 1, apiEstimatedCost: 2 },
    });
  });

  test("marks all-time event-only sessions incomplete", () => {
    const event = eventRow("session-1", 3);
    assert.deepEqual(fold([], [event], [event], false), {
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.CoverageIncomplete,
      subtotalUsd: 3,
      lanes: { subscriptionEquivalentCost: 1, apiEstimatedCost: 2 },
    });
  });

  test("distinguishes explicit-zero legacy cost from absent cost", () => {
    assert.deepEqual(fold([tokenRow("session-1", 0)], [], [], false), {
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.CoverageIncomplete,
      subtotalUsd: 0,
    });
    assert.deepEqual(fold([tokenRow("session-1", null)], [], [], false), {
      completeness: BranchCostCompleteness.Unavailable,
      reason: BranchCostCompletenessReason.CoverageIncomplete,
    });
  });

  test("retains a lifetime fallback when matching events have no subtotal", () => {
    const event = { ...eventRow("session-1", 3), costUsdEstimated: null };
    Reflect.deleteProperty(event, "costSummary");
    assert.deepEqual(
      fold([tokenRow("session-1", 3)], [event], [event], false),
      {
        completeness: BranchCostCompleteness.Partial,
        reason: BranchCostCompletenessReason.CoverageIncomplete,
        subtotalUsd: 3,
      }
    );
  });

  test("keeps a bounded mixed priced and unpriced cohort pricing-incomplete", () => {
    const priced = eventRow("session-1", 3);
    const unpriced = {
      ...eventRow("session-1", 0),
      costUsdEstimated: null,
      sourceIdentity: availableSourceIdentity(["record-unpriced"]),
    };
    Reflect.deleteProperty(unpriced, "costSummary");

    const lifetime = { ...tokenRow("session-1", 3), inputTokens: 2 };
    assert.deepEqual(
      fold([lifetime], [priced, unpriced], [priced, unpriced], true),
      {
        completeness: BranchCostCompleteness.Partial,
        reason: BranchCostCompletenessReason.PricingIncomplete,
        subtotalUsd: 3,
        lanes: { subscriptionEquivalentCost: 1, apiEstimatedCost: 2 },
      }
    );
  });

  test("uses the same truthful subtotal fallback when either surface cap is exceeded", () => {
    const token = tokenRow("session-1", 3);
    const event = eventRow("session-1", 3);

    assert.deepEqual(fold([token], [event], [event], false, true), {
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.CoverageIncomplete,
      subtotalUsd: 3,
    });
    assert.deepEqual(fold([], [event], [event], true, true), {
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.CoverageIncomplete,
      subtotalUsd: 3,
    });
  });

  for (const scenario of BRANCH_COST_COMPLETENESS_PARITY_CASES) {
    test(`matches the shared cross-surface ${scenario.name} state`, () => {
      const tokenRows = [
        {
          ...tokenRow("session-1", scenario.lifetimeCostUsd),
          inputTokens: scenario.lifetimeInputTokens,
        },
      ];
      const eventRows = scenario.events.map((event, index) => {
        const row = {
          ...eventRow("session-1", event.costUsd ?? 0),
          inputTokens: event.inputTokens,
          sourceIdentity: availableSourceIdentity([`parity-record-${index}`]),
        };
        if (event.inputTokens < 0) {
          row.tokenCountsInvalid = true;
        }
        if (event.costUsd === null) {
          row.costUsdEstimated = null;
          Reflect.deleteProperty(row, "costSummary");
        } else {
          row.costSummary = {
            completeness: TokenCostCompleteness.Complete,
            subtotalUsd: event.costUsd,
            lanes: [
              {
                basis: TokenCostBasis.SubscriptionEquivalent,
                subtotalUsd: event.costUsd,
              },
              { basis: TokenCostBasis.ApiEstimated, subtotalUsd: 0 },
            ],
          };
        }
        return row;
      });

      assert.deepEqual(
        fold(
          tokenRows,
          scenario.evidenceExceeded ? [] : eventRows,
          eventRows,
          scenario.windowActive,
          scenario.evidenceExceeded
        ),
        scenario.expected
      );
    });
  }

  test("preserves malformed token precedence when either surface cap is exceeded", () => {
    for (const subtotalUsd of [3, 0]) {
      const token = {
        ...tokenRow("session-1", subtotalUsd),
        tokenCountsInvalid: true as const,
      };
      const event = {
        ...eventRow("session-1", subtotalUsd),
        tokenCountsInvalid: true as const,
      };
      const expected = {
        completeness: BranchCostCompleteness.Partial,
        reason: BranchCostCompletenessReason.Malformed,
        subtotalUsd,
      };

      assert.deepEqual(fold([token], [event], [event], false, true), expected);
      assert.deepEqual(fold([], [event], [event], true, true), expected);
    }
  });

  test("does not let valid costs mask a malformed row under a cap", () => {
    const malformed = eventRow("session-1", -1);
    const valid = eventRow("session-1", 2);

    assert.deepEqual(
      fold([], [malformed, valid], [malformed, valid], true, true),
      {
        completeness: BranchCostCompleteness.Unavailable,
        reason: BranchCostCompletenessReason.Malformed,
      }
    );
  });

  test("preserves a valid lifetime subtotal when all-time cap evidence is malformed", () => {
    const token = tokenRow("session-1", 1);
    const malformed = eventRow("session-1", -1);
    const valid = eventRow("session-1", 2);

    assert.deepEqual(
      fold([token], [malformed, valid], [malformed, valid], false, true),
      {
        completeness: BranchCostCompleteness.Partial,
        reason: BranchCostCompletenessReason.Malformed,
        subtotalUsd: 1,
      }
    );
  });

  test("returns complete zero for an observed empty bounded cohort", () => {
    const token = tokenRow("session-1", 3);

    assert.deepEqual(fold([token], [], [], true), {
      completeness: BranchCostCompleteness.Complete,
      subtotalUsd: 0,
      lanes: { subscriptionEquivalentCost: 0, apiEstimatedCost: 0 },
    });
  });

  test("marks malformed lifetime token aggregates on normal and capped reads", () => {
    const token = {
      ...tokenRow("session-1", 1),
      tokenCountsInvalid: true as const,
    };
    const event = eventRow("session-1", 1);
    for (const capped of [false, true]) {
      const result = fold([token], [event], [event], false, capped);
      assert.equal(result.completeness, BranchCostCompleteness.Partial);
      assert.equal(result.reason, BranchCostCompletenessReason.Malformed);
      assert.equal(result.subtotalUsd, 1);
    }
  });

  test("marks a safe-row token aggregate overflow malformed on normal and capped reads", () => {
    const tokenRows = [
      { ...tokenRow("session-1", 0.5), inputTokens: Number.MAX_SAFE_INTEGER },
      { ...tokenRow("session-1", 0.5), inputTokens: 1 },
    ];
    const eventRows = tokenRows.map((row, index) => ({
      ...eventRow("session-1", 0.5),
      inputTokens: row.inputTokens,
      sourceIdentity: availableSourceIdentity([`overflow-${index}`]),
      costSummary: {
        // Same reason as `availableSourceIdentity` above: `costSummary` is a
        // discriminated union, so spreading `eventRow(...).costSummary` drops
        // the `completeness` discriminant rather than inheriting it. State it.
        completeness: TokenCostCompleteness.Complete,
        subtotalUsd: 0.5,
        lanes: [
          { basis: TokenCostBasis.SubscriptionEquivalent, subtotalUsd: 0.5 },
          { basis: TokenCostBasis.ApiEstimated, subtotalUsd: 0 },
        ],
      },
    }));

    for (const capped of [false, true]) {
      assert.deepEqual(fold(tokenRows, eventRows, eventRows, false, capped), {
        completeness: BranchCostCompleteness.Partial,
        reason: BranchCostCompletenessReason.Malformed,
        subtotalUsd: 1,
        ...(capped
          ? {}
          : {
              lanes: {
                subscriptionEquivalentCost: 1,
                apiEstimatedCost: 0,
              },
            }),
      });
    }
  });

  test("isolates bounded evidence from malformed lifetime cost", () => {
    const event = eventRow("session-1", 3);
    const token = tokenRow("session-1", -1);

    assert.deepEqual(fold([token], [event], [event], false), {
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.Malformed,
      subtotalUsd: 3,
      lanes: { subscriptionEquivalentCost: 1, apiEstimatedCost: 2 },
    });
    assert.deepEqual(fold([token], [event], [event], true), {
      completeness: BranchCostCompleteness.Complete,
      subtotalUsd: 3,
      lanes: { subscriptionEquivalentCost: 1, apiEstimatedCost: 2 },
    });
  });

  test("preserves valid lifetime subtotal when capped event tokens are malformed", () => {
    const token = tokenRow("session-1", 1);
    const malformed = {
      ...eventRow("session-1", 1),
      tokenCountsInvalid: true as const,
    };

    assert.deepEqual(fold([token], [malformed], [malformed], false, true), {
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.Malformed,
      subtotalUsd: 1,
    });
  });

  test("marks matching-token lifetime and event cost divergence incomplete", () => {
    const token = tokenRow("session-1", 100);
    const event = eventRow("session-1", 1);
    const expected = {
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.CoverageIncomplete,
      subtotalUsd: 1,
      lanes: { subscriptionEquivalentCost: 1, apiEstimatedCost: 0 },
    };

    assert.deepEqual(fold([token], [event], [event], false), expected);
    assert.deepEqual(fold([token], [event], [event], true), {
      completeness: BranchCostCompleteness.Complete,
      subtotalUsd: 1,
      lanes: { subscriptionEquivalentCost: 1, apiEstimatedCost: 0 },
    });
  });
});

function fold(
  tokenRows: BranchUsageTokenRow[],
  selectedEvents: BranchUsageTokenRow[],
  allEvents: BranchUsageTokenRow[],
  windowActive: boolean,
  evidenceExceeded = false
) {
  return aggregateBranchCostCompleteness(
    buildDesktopBranchCostEvidence({
      tokenRows,
      evidenceRows: selectedEvents,
      allEventRows: allEvents,
      subtotalRows: windowActive ? selectedEvents : tokenRows,
      windowActive,
      evidenceExceeded,
    })
  );
}

function tokenRow(
  sessionId: string,
  costUsdEstimated: number | null
): BranchUsageTokenRow {
  return {
    sessionId,
    model: "claude-sonnet-4-5",
    inputTokens: 1,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: null,
    cacheWrite1hTokens: null,
    billingMode: null,
    createdAt: "2026-06-10T10:00:00.000Z",
    sessionStartedAt: "2026-06-10T10:00:00.000Z",
    costUsdEstimated,
  };
}

/**
 * The Available `sourceIdentity` branch with a caller-chosen record id.
 *
 * Spreading `eventRow(...).sourceIdentity` cannot express this: the field is a
 * discriminated union that also admits `undefined`, so the spread collapses to a
 * bare `{ sourceRecordIds }` carrying neither discriminant, and the row stops
 * being a `BranchUsageTokenRow`. Build the branch instead of re-deriving it.
 */
function availableSourceIdentity(
  sourceRecordIds: string[]
): BranchUsageTokenRow["sourceIdentity"] {
  return {
    availability: TokenSourceIdentityAvailability.Available,
    scheme: "claude-jsonl",
    sourceRecordIds,
  };
}

function eventRow(sessionId: string, subtotalUsd: number): BranchUsageTokenRow {
  return {
    ...tokenRow(sessionId, subtotalUsd),
    sourceIdentity: availableSourceIdentity([`record-${sessionId}`]),
    costSummary: {
      completeness: TokenCostCompleteness.Complete,
      subtotalUsd,
      lanes: [
        { basis: TokenCostBasis.SubscriptionEquivalent, subtotalUsd: 1 },
        { basis: TokenCostBasis.ApiEstimated, subtotalUsd: subtotalUsd - 1 },
      ],
    },
  };
}
