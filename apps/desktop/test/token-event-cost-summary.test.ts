import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenCostCompletenessReason,
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "@repo/api/src/types/token-cost-provenance";
import type { NormalizedTokenRecord } from "../src/main/collectors/types.js";
import { resolveTokenEventCostSummary } from "../src/main/database/token-event-contract.js";

test("unavailable producer identity makes local cost evidence partial", () => {
  assert.deepEqual(resolveTokenEventCostSummary(unavailableRecord(), 1.25), {
    completeness: TokenCostCompleteness.Partial,
    reason: TokenCostCompletenessReason.SourceIdentityUnavailable,
    subtotalUsd: 1.25,
    lanes: [{ basis: TokenCostBasis.ApiEstimated, subtotalUsd: 1.25 }],
  });
});

test("unavailable producer identity makes missing cost evidence unavailable", () => {
  assert.deepEqual(
    resolveTokenEventCostSummary(unavailableRecord(), undefined),
    {
      completeness: TokenCostCompleteness.Unavailable,
      reason: TokenCostCompletenessReason.SourceIdentityUnavailable,
    }
  );
});

test("omitted legacy identity retains legacy cost compatibility", () => {
  const record = tokenRecord();
  assert.equal(record.sourceIdentity, undefined);
  assert.deepEqual(resolveTokenEventCostSummary(record, undefined), {
    completeness: TokenCostCompleteness.Unavailable,
    reason: TokenCostCompletenessReason.LegacyRecord,
  });
  assert.deepEqual(
    resolveTokenEventCostSummary(
      {
        ...record,
        sourceIdentity: {
          availability: TokenSourceIdentityAvailability.Unavailable,
          reason: TokenSourceIdentityUnavailableReason.LegacyRecord,
        },
      },
      undefined
    ),
    {
      completeness: TokenCostCompleteness.Unavailable,
      reason: TokenCostCompletenessReason.LegacyRecord,
    }
  );
});

function unavailableRecord(): NormalizedTokenRecord {
  return {
    ...tokenRecord(),
    sourceIdentity: {
      availability: TokenSourceIdentityAvailability.Unavailable,
      reason: TokenSourceIdentityUnavailableReason.MissingSourceRecordId,
    },
  };
}

function tokenRecord(): NormalizedTokenRecord {
  return {
    timestamp: "2026-08-02T10:00:00.000Z",
    model: "claude-opus-4-1",
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 3,
  };
}
