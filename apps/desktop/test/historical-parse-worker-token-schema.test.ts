import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenCostCompletenessReason,
  TokenSourceIdentityAvailability,
} from "@repo/api/src/types/token-cost-provenance";
import {
  HistoricalParseWorkerResponseType,
  historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import { parsedSessions } from "./historical-parse-worker-response-support.js";
import { makeSession } from "./normalized-session-test-utils.js";

test("historical worker strictly round-trips token provenance and cost completeness", () => {
  const base = makeSession({ sessionId: "worker-token-provenance-session" });
  const tokenRecord = {
    timestamp: "2026-06-07T10:00:05.000Z",
    model: "provider-neutral-model",
    input: 0,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    transportId: "transport-token-1",
    sourceIdentity: {
      availability: TokenSourceIdentityAvailability.Available,
      scheme: "synthetic-source-v1",
      sourceRecordIds: ["source-b", "source-a"],
    },
    costSummary: {
      completeness: TokenCostCompleteness.Partial,
      reason: TokenCostCompletenessReason.ClassificationIncomplete,
      subtotalUsd: 2.5,
      lanes: [
        {
          basis: TokenCostBasis.SubscriptionEquivalent,
          subtotalUsd: 1.5,
        },
        { basis: TokenCostBasis.ApiEstimated, subtotalUsd: 1 },
      ],
    },
  };
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [{ ...base, tokenSeries: [tokenRecord] }],
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(parsedSessions(result)[0]?.tokenSeries, [tokenRecord]);
  }
});

test("historical worker rejects unmodelled token-record keys", () => {
  const base = makeSession({
    sessionId: "worker-token-provenance-unknown-key",
  });
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...base,
        tokenSeries: [
          {
            ...base.tokenSeries[0],
            unexpectedProvenance: "must-not-strip",
          },
        ],
      },
    ],
  });

  assert.equal(result.success, false);
});
