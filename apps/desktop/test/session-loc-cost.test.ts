import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type {
  SyncedAgentSession,
  SyncedAgentSessionTokenUsage,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  sessionLocalGitLoc,
  sessionLocCost,
} from "../src/main/session/session-loc-cost.js";
import {
  addTotals,
  sumTokenUsage,
  totalsCostMeasured,
  zeroTotals,
} from "../src/main/session/session-usage-totals.js";

describe("session LOC cost projection", () => {
  test("prefers each source-tagged git field independently over loose scalars", () => {
    const session = makeSession({
      linesAdded: 90,
      linesRemoved: 80,
      gitDiffStats: {
        linesAdded: 0,
        linesRemoved: 7,
        filesChanged: 1,
        source: "git",
      },
    });

    assert.equal(sessionLocalGitLoc(session), 7);
  });

  test("falls back to loose scalars and then zero when git evidence is absent", () => {
    assert.equal(
      sessionLocalGitLoc(makeSession({ linesAdded: 5, linesRemoved: 4 })),
      9
    );
    assert.equal(sessionLocalGitLoc(makeSession()), 0);
  });

  test("projects cost and available provenance without fabricating missing values", () => {
    assert.deepEqual(
      locCostFor(
        makeSession({
          branch: "feature/coverage",
          attribution: { repositoryFullName: "closedloop-ai/closedloop-ai" },
          gitDiffStats: {
            linesAdded: 8,
            linesRemoved: 2,
            filesChanged: 1,
            source: "branch_fallback",
          },
          tokenUsageByModel: [usageRow(1.25)],
        })
      ),
      {
        loc: 10,
        cost: 1.25,
        costMeasured: true,
        locSource: "branch_fallback",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        branch: "feature/coverage",
      }
    );
  });

  // ISS-11226: the three states the old `estimatedCost: number` collapsed into a
  // single `0`, and which `costMeasured: true` then published as measured.
  test("reports a session with no token-usage rows as UNMEASURED, not $0", () => {
    const entry = locCostFor(makeSession());

    assert.equal(entry.cost, 0);
    assert.equal(entry.costMeasured, false);
  });

  test("reports rows whose cost is null as UNMEASURED", () => {
    const entry = locCostFor(
      makeSession({ tokenUsageByModel: [usageRow(), nullCostUsageRow()] })
    );

    assert.equal(entry.cost, 0);
    assert.equal(entry.costMeasured, false);
  });

  test("reports rows that priced out to exactly zero as MEASURED", () => {
    const entry = locCostFor(
      makeSession({ tokenUsageByModel: [usageRow(0), usageRow(0)] })
    );

    assert.equal(entry.cost, 0);
    assert.equal(
      entry.costMeasured,
      true,
      "a measured $0 is a figure we know — the case the defect was about"
    );
  });

  test("reports a partially priced session as UNMEASURED", () => {
    const entry = locCostFor(
      makeSession({ tokenUsageByModel: [usageRow(2), usageRow()] })
    );

    assert.equal(entry.cost, 2);
    assert.equal(entry.costMeasured, false);
  });

  // ISS-11226 review (whitlockk, codex): the measured states the token-row counters
  // cannot see. `sessionAnalytics.estimatedCostUsd` is the validated output of
  // `resolveSyncedSessionCostUsd`, the same figure the cloud persists to
  // `SessionDetail.estimatedCost` and reads back as `estimatedCost !== null`.
  test("reports a web-search-only session as MEASURED at its real cost", () => {
    const entry = locCostFor(
      makeSession({ sessionAnalytics: analytics(0.42) })
    );

    assert.equal(
      entry.cost,
      0.42,
      "web-search cost never appears in tokenUsageByModel, so the counters alone report $0"
    );
    assert.equal(entry.costMeasured, true);
  });

  test("an authoritative null cost is UNMEASURED even when token rows are priced", () => {
    const entry = locCostFor(
      makeSession({
        tokenUsageByModel: [usageRow(2)],
        sessionAnalytics: analytics(null),
      })
    );

    assert.equal(
      entry.cost,
      2,
      "the partial sum stays; only the verdict changes"
    );
    assert.equal(entry.costMeasured, false);
  });

  test("the authoritative cost wins over the per-model sum", () => {
    const entry = locCostFor(
      makeSession({
        tokenUsageByModel: [usageRow(2)],
        sessionAnalytics: analytics(2.5),
      })
    );

    assert.equal(entry.cost, 2.5);
    assert.equal(entry.costMeasured, true);
  });

  test("an authoritative measured $0 is the figure it is", () => {
    const entry = locCostFor(makeSession({ sessionAnalytics: analytics(0) }));

    assert.equal(entry.cost, 0);
    assert.equal(entry.costMeasured, true);
  });

  test("an impossible authoritative cost is unmeasured, not a measurement", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const entry = locCostFor(
        makeSession({
          tokenUsageByModel: [usageRow(3)],
          sessionAnalytics: analytics(bad),
        })
      );

      assert.equal(entry.costMeasured, false, `rejects ${bad}`);
      assert.equal(entry.cost, 3);
    }
  });

  test("falls back to token-row coverage when the session carries no analytics rollup", () => {
    const measured = locCostFor(
      makeSession({ tokenUsageByModel: [usageRow(1.5)] })
    );
    const unmeasured = locCostFor(
      makeSession({ tokenUsageByModel: [usageRow(1.5), usageRow()] })
    );

    assert.equal(measured.costMeasured, true);
    assert.equal(unmeasured.costMeasured, false);
  });

  test("treats a non-finite cost as unmeasured, not as a measurement", () => {
    const entry = locCostFor(
      makeSession({ tokenUsageByModel: [usageRow(Number.NaN)] })
    );

    assert.equal(entry.costMeasured, false);
  });
});

describe("session totals cost coverage", () => {
  test("zeroTotals is the identity: it adds no members in either counter", () => {
    const totals = zeroTotals();
    addTotals(totals, zeroTotals());

    assert.deepEqual(
      { measured: totals.costMeasuredMembers, members: totals.costMembers },
      { measured: 0, members: 0 }
    );
    assert.equal(totalsCostMeasured(totals), false);
  });

  test("addTotals: measured + unmeasured is NOT measured", () => {
    const measured = sumTokenUsage(
      makeSession({ tokenUsageByModel: [usageRow(3)] })
    );
    const unmeasured = sumTokenUsage(
      makeSession({ tokenUsageByModel: [nullCostUsageRow()] })
    );
    assert.equal(totalsCostMeasured(measured), true);
    assert.equal(totalsCostMeasured(unmeasured), false);

    const combined = zeroTotals();
    addTotals(combined, measured);
    addTotals(combined, unmeasured);

    assert.equal(combined.estimatedCost, 3);
    assert.equal(
      totalsCostMeasured(combined),
      false,
      "combining a measured total with an unmeasured one must not read as measured"
    );
  });

  test("addTotals: measured + measured stays measured", () => {
    const combined = zeroTotals();
    addTotals(
      combined,
      sumTokenUsage(makeSession({ tokenUsageByModel: [usageRow(3)] }))
    );
    addTotals(
      combined,
      sumTokenUsage(makeSession({ tokenUsageByModel: [usageRow(0)] }))
    );

    assert.equal(combined.estimatedCost, 3);
    assert.equal(totalsCostMeasured(combined), true);
  });
});

/**
 * The production wiring, verbatim: `shared-agent-sessions-api.ts` projects every
 * entry as `sessionLocCost(session, sumTokenUsage(session))`, so the tests below
 * exercise the same pair rather than hand-building a totals object that cannot
 * occur.
 */
function locCostFor(session: SyncedAgentSession) {
  return sessionLocCost(session, sumTokenUsage(session));
}

/** A priced row. `estimatedCostUsd` omitted = the producer reported no cost. */
function usageRow(estimatedCostUsd?: number): SyncedAgentSessionTokenUsage {
  return {
    model: "claude-sonnet-4-5",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
  };
}

/**
 * The wire shape the TYPE forbids but a version-skewed desktop can still send:
 * `estimatedCostUsd` present and explicitly null. `tokenUsageByModel` crosses
 * the sync boundary, so this input is reachable at runtime and is covered here
 * as well as the omitted-key shape above.
 */
function nullCostUsageRow(): SyncedAgentSessionTokenUsage {
  // Test-file double cast (FEA-4114 exempts test code): the point of the case is
  // a value the in-process type forbids and the wire can still deliver.
  return {
    ...usageRow(),
    estimatedCostUsd: null,
  } as unknown as SyncedAgentSessionTokenUsage;
}

function makeSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "session-1",
    name: null,
    status: "completed",
    harness: "claude",
    model: "claude-sonnet-4-5",
    startedAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    endedAt: null,
    metadata: null,
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  } as SyncedAgentSession;
}

/**
 * The desktop `session_analytics` rollup as `sync-source.ts` hydrates it, carrying
 * the validated whole-session cost `resolveSyncedSessionCostUsd` chose. Only
 * `estimatedCostUsd` is read here; the rest is the rollup's required shape.
 */
function analytics(
  estimatedCostUsd: number | null
): NonNullable<SyncedAgentSession["sessionAnalytics"]> {
  return {
    isHuman: false,
    humanTurns: 0,
    agentTurns: 0,
    eventCount: 0,
    toolInvocations: 0,
    errorEvents: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd,
  };
}
