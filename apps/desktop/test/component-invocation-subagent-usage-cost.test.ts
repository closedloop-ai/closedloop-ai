/**
 * ISS-7261: the subagent half of per-invocation telemetry, plus the money column.
 *
 * Before this, `sessions.metadata.tokenSeries[]` already carried
 * `subagentId`-stamped records and `agent_component_invocations` already had the
 * columns to hold them — the derivation simply never joined the two, and nothing
 * at all ever wrote `estimated_cost`. So the assertions below are on the derived
 * CANDIDATE VALUES that reach the insert, not on a producer having been called:
 * the whole pipeline existed while every one of these columns was NULL, and a
 * test that only proved the derivation ran would pass against the exact bug.
 */
import assert from "node:assert/strict";
import {
  AgentComponentInvocationKind,
  AgentComponentInvocationUsageMeasurement,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, test } from "vitest";
import {
  type AgentComponentInvocationCandidate,
  insertInvocationRows,
  invocationTelemetryColumns,
  NO_INVOCATION_TELEMETRY,
} from "../src/main/database/component-invocation-row-writer.js";
import { deriveAgentComponentInvocationCandidates } from "../src/main/database/component-invocations.js";
import { estimateTokenCost } from "../src/shared/token-cost.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-08-19T12:00:00.000Z";
const MAIN_AGENT = "main-agent";
const AT = "2026-08-19T09:00:00.000Z";
const REVIEWER = "019ec93a-b1f0-7140-b416-5e653d85dd67";
const EXPLORER = "019ec93a-b1f0-7140-b416-5e653d85dd68";

/**
 * Two subagents and a parent, because "the right rows are attributed" is
 * vacuous against a one-subagent corpus: a derivation that credited every
 * subagent the session total would satisfy it.
 */
function session() {
  return makeSession({
    sessionId: "iss7261-session",
    subagents: [
      { id: REVIEWER, name: "review-soul", type: "review-soul", startedAt: AT },
      { id: EXPLORER, name: "Explore", type: "Explore", startedAt: AT },
    ],
    tokenSeries: [
      // The parent's own round-trips — attributable to neither subagent.
      {
        timestamp: AT,
        model: "claude-opus-4-1",
        input: 500_000,
        output: 9000,
        cacheRead: 0,
        cacheWrite: 0,
      },
      {
        timestamp: AT,
        model: "claude-opus-4-1",
        input: 1200,
        output: 300,
        cacheRead: 400,
        cacheWrite: 100,
        subagentId: REVIEWER,
      },
      {
        timestamp: AT,
        model: "claude-sonnet-4-5",
        input: 800,
        output: 60,
        cacheRead: 0,
        cacheWrite: 0,
        subagentId: EXPLORER,
      },
      // A second model for the SAME subagent: the row can no longer name one.
      {
        timestamp: AT,
        model: "claude-sonnet-4-5",
        input: 300,
        output: 40,
        cacheRead: 0,
        cacheWrite: 0,
        subagentId: REVIEWER,
      },
    ],
  });
}

function subagentCandidates() {
  return deriveAgentComponentInvocationCandidates(session(), MAIN_AGENT, NOW)
    .filter(
      (candidate) =>
        candidate.componentKind === AgentComponentInvocationKind.Subagent
    )
    .reduce(
      (byKey, candidate) => byKey.set(candidate.componentKey, candidate),
      new Map<
        string,
        ReturnType<typeof deriveAgentComponentInvocationCandidates>[number]
      >()
    );
}

describe("per-subagent invocation telemetry (ISS-7261)", () => {
  test("each subagent carries its own measured tokens, never the session's", () => {
    const explorer = subagentCandidates().get("Explore");

    assert.equal(
      explorer?.usageMeasurement,
      AgentComponentInvocationUsageMeasurement.Measured
    );
    assert.equal(explorer?.model, "claude-sonnet-4-5");
    // 800, not 500_800: the parent's round-trip is not this subagent's work.
    assert.equal(explorer?.inputTokens, 800);
    assert.equal(explorer?.outputTokens, 60);
  });

  test("a subagent served by two models sums both, names neither, and prices each turn", () => {
    const reviewer = subagentCandidates().get("review-soul");

    assert.equal(reviewer?.inputTokens, 1500);
    assert.equal(reviewer?.outputTokens, 340);
    assert.equal(reviewer?.cacheReadTokens, 400);
    assert.equal(reviewer?.cacheWriteTokens, 100);
    // Mixed-model: `model` is the model that served the row or an admission that
    // none did. ISS-7361: the money no longer needs one model for the row —
    // each round-trip is priced under its own model and the prices summed, so
    // the mixed row is priced rather than NULL (it was NULL only because the
    // fold could not be priced as one request).
    assert.equal(reviewer?.model, null);
    const opusTurn = estimateTokenCost({
      model: "claude-opus-4-1",
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
      observedAt: AT,
    });
    const sonnetTurn = estimateTokenCost({
      model: "claude-sonnet-4-5",
      inputTokens: 300,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      observedAt: AT,
    });
    assert.equal(typeof opusTurn?.costUsd, "number");
    assert.equal(typeof sonnetTurn?.costUsd, "number");
    assert.equal(
      reviewer?.estimatedCost,
      (opusTurn?.costUsd ?? 0) + (sonnetTurn?.costUsd ?? 0)
    );
    assert.equal(
      reviewer?.usageMeasurement,
      AgentComponentInvocationUsageMeasurement.Measured
    );
  });

  test("a single-model subagent is priced, and priced above zero", () => {
    const explorer = subagentCandidates().get("Explore");

    assert.equal(typeof explorer?.estimatedCost, "number");
    assert.ok(
      (explorer?.estimatedCost ?? 0) > 0,
      "measured tokens on a priceable model must not cost 0"
    );
  });
});

describe("invocationTelemetryColumns bad-data refusal (ISS-7261)", () => {
  test("withholds the WHOLE row when a count is corrupt", () => {
    assert.deepEqual(
      invocationTelemetryColumns({
        usage: {
          model: "claude-opus-4-1",
          inputTokens: -1,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        invokedAt: AT,
        sessionId: "iss7261-session",
      }),
      // Not "the bad count zeroed and the rest kept" — a partially-valid
      // measured row is exactly what must never be persisted. The refusal
      // rides along so the writer can REPORT it: a stored NULL is otherwise
      // indistinguishable from "nothing ever measured this".
      //
      // Written out instead of spread from NO_INVOCATION_TELEMETRY: the
      // producer spreads that same constant, so an expectation derived from it
      // moves with it. `estimatedCost: null -> 0` there would leave this green
      // while a refused row rendered as a confident $0.
      {
        model: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        estimatedCost: null,
        usageMeasurement: null,
        usageRefusedCorruptCounts: true,
      }
    );
  });

  test("still measures a genuine zero-count row", () => {
    const columns = invocationTelemetryColumns({
      usage: {
        model: "claude-opus-4-1",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      invokedAt: AT,
      sessionId: "iss7261-session",
    });

    // The positive sibling of the refusal above: 0 is a measured value, and the
    // guard must reject corruption without also rejecting it.
    assert.equal(
      columns.usageMeasurement,
      AgentComponentInvocationUsageMeasurement.Measured
    );
    assert.equal(columns.inputTokens, 0);
    assert.equal(columns.usageRefusedCorruptCounts, undefined);
  });
});

describe("unpriceable models report unknown, not a floor (ISS-7261)", () => {
  test("a model only the fallback tier can price keeps its counts and no cost", () => {
    // ISS-7762's unknown-model fallback still returns a PRICED figure at the
    // Opus-standard tier, and this table has no `cost_source` column to say so.
    // A guessed floor indistinguishable from a confirmed rate is the
    // plausible-but-wrong number, so the row reports unknown instead.
    const columns = invocationTelemetryColumns({
      usage: {
        model: "claude-sonnet-4-99-not-in-the-table",
        inputTokens: 800,
        outputTokens: 60,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      invokedAt: AT,
      sessionId: "iss7261-session",
    });

    assert.equal(columns.estimatedCost, null);
    // The counts are real and stay — only the money is unknown.
    assert.equal(columns.inputTokens, 800);
    assert.equal(
      columns.usageMeasurement,
      AgentComponentInvocationUsageMeasurement.Measured
    );
  });
});

describe("the corrupt-count refusal is reported, not swallowed (ISS-7261)", () => {
  test("insertInvocationRows tells its required logger how many rows it withheld", async () => {
    const messages: string[] = [];
    const candidate = {
      ...baseInvocationCandidate(),
      ...invocationTelemetryColumns({
        usage: {
          model: "claude-opus-4-1",
          inputTokens: Number.POSITIVE_INFINITY,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        invokedAt: AT,
        sessionId: "iss7261-session",
      }),
    };

    await insertInvocationRows(
      stubTransaction(),
      "iss7261-session",
      [candidate],
      (message) => messages.push(message)
    );

    // The stored NULL is indistinguishable from "nothing ever measured this",
    // so the count is the only thing that makes a collector emitting impossible
    // numbers discoverable at all.
    assert.equal(
      messages.filter((message) =>
        message.includes("withheld measured telemetry on 1 row")
      ).length,
      1
    );
    // Negative sibling on the same spy: a clean row says nothing.
    const quiet: string[] = [];
    await insertInvocationRows(
      stubTransaction(),
      "iss7261-session",
      [{ ...baseInvocationCandidate(), ...NO_INVOCATION_TELEMETRY }],
      (message) => quiet.push(message)
    );
    assert.equal(
      quiet.filter((message) => message.includes("withheld measured telemetry"))
        .length,
      0
    );
  });
});

/**
 * FEA-3419 prices a ONE-HOUR ephemeral cache write at 2x the base input rate and
 * a five-minute one at 1.25x, and `estimateTokenCost` charges an OMITTED
 * one-hour count at the five-minute rate. So a fold that summed `cacheWrite` and
 * dropped `cacheWriteTtl.oneH` produced a silently understated `estimated_cost`
 * — the plausible-but-wrong number, with no visible failure.
 *
 * The fixture is cache-write-ONLY (no input/output/cacheRead) so the whole row
 * cost IS the cache-write cost, which makes the expected ratio exact rather than
 * approximate: an all-one-hour bucket must cost 1.6x the same bucket priced at
 * five minutes (2.0 / 1.25). An assertion that only proved the field survived
 * the fold would stay green while the price was still wrong.
 */
const CACHE_WRITE_ONLY_TOKENS = 1_000_000;
const ONE_HOUR_OVER_FIVE_MINUTE_RATIO = 1.6;

function cacheWriteOnlySession(cacheWriteTtl?: {
  fiveM: number;
  oneH: number;
}) {
  return makeSession({
    sessionId: "iss7261-ttl-session",
    subagents: [
      { id: EXPLORER, name: "Explore", type: "Explore", startedAt: AT },
    ],
    tokenSeries: [
      {
        timestamp: AT,
        model: "claude-sonnet-4-5",
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: CACHE_WRITE_ONLY_TOKENS,
        subagentId: EXPLORER,
        ...(cacheWriteTtl ? { cacheWriteTtl } : {}),
      },
    ],
  });
}

function cacheWriteOnlyCost(cacheWriteTtl?: {
  fiveM: number;
  oneH: number;
}): number | null {
  const candidate = deriveAgentComponentInvocationCandidates(
    cacheWriteOnlySession(cacheWriteTtl),
    MAIN_AGENT,
    NOW
  ).find(
    (row) =>
      row.componentKind === AgentComponentInvocationKind.Subagent &&
      row.componentKey === "Explore"
  );
  return candidate?.estimatedCost ?? null;
}

describe("one-hour cache writes are priced at the one-hour rate (ISS-7261)", () => {
  test("an all-one-hour bucket costs 1.6x the same bucket priced at five minutes", () => {
    const fiveMinute = cacheWriteOnlyCost();
    const oneHour = cacheWriteOnlyCost({
      fiveM: 0,
      oneH: CACHE_WRITE_ONLY_TOKENS,
    });

    // A null on either side would make the comparisons below vacuous.
    assert.equal(typeof fiveMinute, "number");
    assert.equal(typeof oneHour, "number");
    // Strictly more money, not merely a different shape: dropping the split
    // charged these tokens the cheaper rate.
    assert.ok(
      (oneHour ?? 0) > (fiveMinute ?? 0),
      `one-hour writes must cost more than five-minute writes (${oneHour} vs ${fiveMinute})`
    );
    const expected = (fiveMinute ?? 0) * ONE_HOUR_OVER_FIVE_MINUTE_RATIO;
    assert.ok(
      Math.abs((oneHour ?? 0) - expected) < 1e-9,
      `expected ${expected}, got ${oneHour}`
    );
  });

  test("a reported all-five-minute split prices identically to no split at all", () => {
    // The negative sibling: the premium must attach to the ONE-HOUR lane only.
    // Without this, a fix that simply raised every cache write would pass above.
    assert.equal(
      cacheWriteOnlyCost({ fiveM: CACHE_WRITE_ONLY_TOKENS, oneH: 0 }),
      cacheWriteOnlyCost()
    );
  });
});

/** The minimum a candidate needs to reach the insert; nothing here is asserted. */
function baseInvocationCandidate(): AgentComponentInvocationCandidate {
  return {
    externalInvocationId: "subagent:iss7261",
    footprintTokens: null,
    externalSourceId: null,
    childSessionId: null,
    agentId: null,
    parentAgentId: null,
    componentKind: AgentComponentInvocationKind.Subagent,
    componentKey: "review-soul",
    rawName: "review-soul",
    normalizedName: "review-soul",
    relationship: "direct",
    invokedAt: AT,
    sourceOrder: 0,
    sequence: 0,
    anchorKind: "session",
    anchorValue: "iss7261-session",
    providerToolUseId: null,
    attributionStatus: "unresolved",
    evidenceClass: "none",
    evidencePointer: null,
    definitionHash: null,
    normalizerContractVersion: null,
    definitionContent: null,
    localComponentId: null,
    localComponentVersionId: null,
    gitBranch: null,
    repositoryFullName: null,
    succeeded: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    estimatedCost: null,
    usageMeasurement: null,
    linesAdded: null,
    linesRemoved: null,
    findingsEmitted: null,
    findingsInvalidated: null,
    // ISS-11325: no disposition recorded on a fixture the findings ingest never reached.
    findingsDisposition: null,
    attributionSource: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** Enough of a transaction for the writer to run: no agents, no real insert. */
function stubTransaction() {
  return {
    agent: { findMany: () => Promise.resolve([]) },
    $executeRawUnsafe: () => Promise.resolve(0),
  } as unknown as Parameters<typeof insertInvocationRows>[0];
}
