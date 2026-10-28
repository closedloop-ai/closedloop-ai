/**
 * ISS-7361: a component invocation is priced one round-trip at a time.
 *
 * genai-prices 0.1.9 tiers gpt-5.5 per request — the input rate doubles once a
 * single prompt reaches 272K tokens. The invocation writer used to fold a
 * subagent's whole run into one bucket and price THAT, so a run of small
 * requests whose lifetime volume crossed the threshold was charged the tier on
 * every token, and six invocations came to sum above the session that ran
 * them. The assertions below are on the money that reaches the insert, against
 * a fixture no single request of which is anywhere near the threshold.
 */
import assert from "node:assert/strict";
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import type {
  NormalizedComponentUsage,
  NormalizedTokenRecord,
} from "@repo/lib/harness/types";
import { describe, test } from "vitest";
import { invocationTelemetryColumns } from "../src/main/database/component-invocation-row-writer.js";
import { deriveAgentComponentInvocationCandidates } from "../src/main/database/component-invocations.js";
import { estimateTokenCost } from "../src/shared/token-cost.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-09-03T12:00:00.000Z";
const MAIN_AGENT = "main-agent";
const AT = "2026-09-03T09:00:00.000Z";
const EXPLORER = "019ec93a-b1f0-7140-b416-5e653d85dd68";
const SESSION_ID = "iss7361-session";
const TIERED_MODEL = "gpt-5.5";

/**
 * Four requests of 100K prompt tokens each. Alone, every one is well below the
 * 272K long-context threshold; folded, the run is 400K and lands in the tier.
 * That gap is the whole defect, so the fixture has to straddle the threshold
 * this way or the two pricing orders agree and nothing here can fail.
 */
const REQUESTS: NormalizedTokenRecord[] = [1, 2, 3, 4].map((n) => ({
  timestamp: `2026-09-03T09:0${n}:00.000Z`,
  model: TIERED_MODEL,
  input: 100_000,
  output: 2000,
  cacheRead: 0,
  cacheWrite: 0,
  subagentId: EXPLORER,
}));

function foldOf(
  records: readonly NormalizedTokenRecord[]
): NormalizedComponentUsage {
  return {
    model: TIERED_MODEL,
    inputTokens: records.reduce((sum, r) => sum + r.input, 0),
    outputTokens: records.reduce((sum, r) => sum + r.output, 0),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/** NaN when the library refuses, so a vacuous comparison cannot pass below. */
function priceAlone(record: NormalizedTokenRecord): number {
  return (
    estimateTokenCost({
      model: record.model,
      inputTokens: record.input,
      outputTokens: record.output,
      cacheReadTokens: record.cacheRead,
      cacheWriteTokens: record.cacheWrite,
      observedAt: record.timestamp,
    })?.costUsd ?? Number.NaN
  );
}

function foldedPrice(usage: NormalizedComponentUsage): number {
  return (
    estimateTokenCost({
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      observedAt: AT,
    })?.costUsd ?? Number.NaN
  );
}

describe("per-request invocation pricing (ISS-7361)", () => {
  test("the money column is Σ price(request), not price(Σ requests)", () => {
    const perRequest = REQUESTS.reduce((sum, r) => sum + priceAlone(r), 0);
    const folded = foldedPrice(foldOf(REQUESTS));
    assert.ok(Number.isFinite(perRequest) && Number.isFinite(folded));
    // The counterfactual must be distinguishable, or a writer that still
    // prices the fold passes: the library charges the fold the tier.
    assert.ok(
      folded > perRequest * 1.5,
      `fixture does not straddle the tier (fold ${folded}, per-request ${perRequest})`
    );

    const columns = invocationTelemetryColumns({
      usage: foldOf(REQUESTS),
      usageRecords: REQUESTS,
      invokedAt: AT,
      sessionId: SESSION_ID,
    });

    assert.equal(columns.estimatedCost, perRequest);
  });

  test("the production derivation hands the writer the records, not just the fold", () => {
    const session = makeSession({
      sessionId: SESSION_ID,
      subagents: [
        { id: EXPLORER, name: "Explore", type: "Explore", startedAt: AT },
      ],
      tokenSeries: [
        // The parent's own round-trip, attributable to no subagent.
        {
          timestamp: AT,
          model: TIERED_MODEL,
          input: 50_000,
          output: 500,
          cacheRead: 0,
          cacheWrite: 0,
        },
        ...REQUESTS,
      ],
    });
    const explorer = deriveAgentComponentInvocationCandidates(
      session,
      MAIN_AGENT,
      NOW
    ).find(
      (candidate) =>
        candidate.componentKind === AgentComponentInvocationKind.Subagent &&
        candidate.componentKey === "Explore"
    );

    assert.equal(explorer?.inputTokens, 400_000);
    assert.equal(
      explorer?.estimatedCost,
      REQUESTS.reduce((sum, r) => sum + priceAlone(r), 0)
    );
  });

  test("with no records in hand the fold is priced as one request", () => {
    // The Claude skill/command attribution folds inside the parser and hands
    // over no records; that producer keeps the pre-ISS-7361 answer rather than
    // getting a NULL it never had.
    const usage = foldOf(REQUESTS);
    const columns = invocationTelemetryColumns({
      usage,
      invokedAt: AT,
      sessionId: SESSION_ID,
    });

    assert.ok(Number.isFinite(foldedPrice(usage)));
    assert.equal(columns.estimatedCost, foldedPrice(usage));
  });

  test("records that do not add up to the fold are refused in favour of the fold", () => {
    // A fold paired with someone else's turns: the counts beside the money are
    // the fold's, so the only honest price for them is the fold's (FEA-3232's
    // fail-closed rule). The mismatch is one dropped request.
    const usage = foldOf(REQUESTS);
    const columns = invocationTelemetryColumns({
      usage,
      usageRecords: REQUESTS.slice(1),
      invokedAt: AT,
      sessionId: SESSION_ID,
    });

    assert.equal(columns.estimatedCost, foldedPrice(usage));
  });

  test("one unpriceable request makes the whole invocation unpriced, not partly priced", () => {
    const records: NormalizedTokenRecord[] = [
      ...REQUESTS.slice(0, 2),
      { ...REQUESTS[2], model: "gpt-5.9-zzz-unknown" },
    ];
    const usage: NormalizedComponentUsage = { ...foldOf(records), model: null };
    const columns = invocationTelemetryColumns({
      usage,
      usageRecords: records,
      invokedAt: AT,
      sessionId: SESSION_ID,
    });

    // A partial sum would read as a confident, too-small number.
    assert.equal(columns.estimatedCost, null);
    assert.equal(columns.inputTokens, 300_000);
  });

  test("a one-hour cache write is priced at the one-hour rate per request", () => {
    const record: NormalizedTokenRecord = {
      timestamp: AT,
      model: "claude-opus-4-1",
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 10_000,
      cacheWriteTtl: { fiveM: 0, oneH: 10_000 },
      subagentId: EXPLORER,
    };
    const usage: NormalizedComponentUsage = {
      model: record.model,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 10_000,
      cacheWriteTtl: { fiveM: 0, oneH: 10_000 },
    };
    const oneHour = invocationTelemetryColumns({
      usage,
      usageRecords: [record],
      invokedAt: AT,
      sessionId: SESSION_ID,
    }).estimatedCost;
    const fiveMinute = invocationTelemetryColumns({
      usage: { ...usage, cacheWriteTtl: { fiveM: 10_000, oneH: 0 } },
      usageRecords: [{ ...record, cacheWriteTtl: { fiveM: 10_000, oneH: 0 } }],
      invokedAt: AT,
      sessionId: SESSION_ID,
    }).estimatedCost;

    assert.equal(typeof oneHour, "number");
    assert.equal(typeof fiveMinute, "number");
    // Dropping the split on the per-request path would price these at the
    // five-minute rate and the two would agree.
    assert.ok((oneHour ?? 0) > (fiveMinute ?? 0));
  });
});
