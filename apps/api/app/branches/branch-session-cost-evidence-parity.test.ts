import {
  aggregateBranchCostCompleteness,
  branchCostEvidenceByteBudget,
  branchCostEvidenceRowBudget,
} from "@repo/api/src/types/branch-usage";
import {
  TokenCostCompleteness,
  TokenSourceIdentityAvailability,
} from "@repo/api/src/types/token-cost-provenance";
import {
  BRANCH_COST_COMPLETENESS_PARITY_CASES,
  type BranchCostParityCase,
  BranchCostParityState,
} from "@repo/lib/branches/__tests__/cost-completeness-parity-fixture";
import { describe, expect, it, vi } from "vitest";
import type {
  LinkedSession,
  SessionUsageClient,
} from "./branch-read-service/session-usage-window";
import { resolveSessionEventEvidence } from "./branch-session-cost-evidence";

describe("Cloud Branch cost-completeness parity and resource bounds", () => {
  it.each(
    BRANCH_COST_COMPLETENESS_PARITY_CASES
  )("matches the shared cross-surface $name state", async (scenario) => {
    expect(await resolveParityCase(scenario)).toEqual(scenario.expected);
  });

  it("bounds all-time evidence work by 1,000-session chunks", async () => {
    const { db, eventEvidenceQuery, eventGroupBy } =
      makeLargeOrganizationClient();
    const sessions = Array.from({ length: 2001 }, (_, index) =>
      linkedSession(`session-${index}`, 0, 0)
    );

    await resolveSessionEventEvidence(db, "org-1", sessions, undefined);

    expect(eventGroupBy).toHaveBeenCalledTimes(3);
    expect(eventEvidenceQuery).toHaveBeenCalledTimes(3);
    for (const [args] of eventGroupBy.mock.calls) {
      expect(args.where.agentSessionId.in.length).toBeLessThanOrEqual(1000);
    }
  });

  it("stops all-time evidence hydration after the request-wide cap is exceeded", async () => {
    const { db, eventEvidenceQuery, eventGroupBy } =
      makeLargeOrganizationClient({ evidenceExceeded: true });
    const sessions = Array.from({ length: 2001 }, (_, index) =>
      linkedSession(`session-${index}`, 0, 0)
    );

    await resolveSessionEventEvidence(db, "org-1", sessions, undefined);

    expect(eventGroupBy).toHaveBeenCalledTimes(3);
    expect(eventEvidenceQuery).toHaveBeenCalledOnce();
  });
});

async function resolveParityCase(scenario: BranchCostParityCase) {
  const events = scenario.events.map((event, index) =>
    cloudEvent(index, event.inputTokens, event.costUsd)
  );
  const eventGroupBy = vi.fn().mockResolvedValue(aggregateRows(events));
  const eventEvidenceQuery = vi
    .fn()
    .mockResolvedValue(
      scenario.evidenceExceeded
        ? [
            metadataRow(
              scenario.state === BranchCostParityState.RowCap
                ? branchCostEvidenceRowBudget + 1
                : 1,
              scenario.state === BranchCostParityState.ByteCap
                ? branchCostEvidenceByteBudget + 1
                : 0
            ),
          ]
        : evidenceRows(events)
    );
  const db = {
    $queryRaw: eventEvidenceQuery,
    agentSessionTokenEvent: { groupBy: eventGroupBy },
  } as unknown as SessionUsageClient;
  const result = await resolveSessionEventEvidence(
    db,
    "org-1",
    [
      linkedSession(
        "session-1",
        scenario.lifetimeCostUsd,
        scenario.lifetimeInputTokens
      ),
    ],
    scenario.windowActive
      ? { startDate: new Date("2026-06-01T00:00:00.000Z") }
      : undefined
  );
  return aggregateBranchCostCompleteness(result.contributions);
}

function makeLargeOrganizationClient(
  options: { evidenceExceeded?: boolean } = {}
) {
  const eventGroupBy = vi.fn().mockResolvedValue([]);
  const eventEvidenceQuery = vi
    .fn()
    .mockResolvedValue([
      metadataRow(
        options.evidenceExceeded ? branchCostEvidenceRowBudget + 1 : 0,
        0
      ),
    ]);
  const db = {
    $queryRaw: eventEvidenceQuery,
    agentSessionTokenEvent: { groupBy: eventGroupBy },
  } as unknown as SessionUsageClient;
  return { db, eventEvidenceQuery, eventGroupBy };
}

function linkedSession(
  artifactId: string,
  estimatedCost: number,
  inputTokens: number
): LinkedSession {
  return {
    artifactId,
    externalSessionId: artifactId,
    harness: "claude",
    sessionStartedAt: new Date("2026-06-10T10:00:00.000Z"),
    sessionEndedAt: null,
    estimatedCost,
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    billingMode: null,
    userId: null,
  };
}

function cloudEvent(
  index: number,
  inputTokens: number,
  costUsd: number | null
) {
  return {
    id: `parity-event-${index}`,
    agentSessionId: "session-1",
    eventCreatedAt: new Date("2026-06-10T10:00:00.000Z"),
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: costUsd,
    sourceIdentity: {
      availability: TokenSourceIdentityAvailability.Available,
      scheme: "parity-fixture",
      sourceRecordIds: [`parity-record-${index}`],
    },
    costCompleteness: costUsd === null ? null : TokenCostCompleteness.Complete,
    costCompletenessReason: null,
    subscriptionEquivalentCost: costUsd,
    apiEstimatedCost: costUsd === null ? null : 0,
  };
}

function aggregateRows(events: readonly ReturnType<typeof cloudEvent>[]) {
  if (events.length === 0) {
    return [];
  }
  const priced = events.filter((event) => event.estimatedCost !== null);
  return [
    {
      agentSessionId: "session-1",
      _sum: {
        inputTokens: events.reduce(
          (total, event) => total + BigInt(event.inputTokens),
          0n
        ),
        outputTokens: 0n,
        cacheReadTokens: 0n,
        cacheWriteTokens: 0n,
        estimatedCost:
          priced.length === 0
            ? null
            : priced.reduce(
                (total, event) => total + (event.estimatedCost ?? 0),
                0
              ),
      },
      _min: {
        inputTokens: Math.min(...events.map((event) => event.inputTokens)),
        outputTokens: 0n,
        cacheReadTokens: 0n,
        cacheWriteTokens: 0n,
        estimatedCost:
          priced.length === 0
            ? null
            : Math.min(...priced.map((event) => event.estimatedCost ?? 0)),
      },
      _count: { _all: events.length, estimatedCost: priced.length },
    },
  ];
}

function evidenceRows(events: readonly ReturnType<typeof cloudEvent>[]) {
  if (events.length === 0) {
    return [metadataRow(0, 0)];
  }
  return events.map((event) => ({
    ...event,
    evidenceCount: events.length,
    retainedBytes: events.length,
  }));
}

function metadataRow(evidenceCount: number, retainedBytes: number) {
  return {
    id: null,
    agentSessionId: null,
    eventCreatedAt: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    estimatedCost: null,
    sourceIdentity: null,
    costCompleteness: null,
    costCompletenessReason: null,
    subscriptionEquivalentCost: null,
    apiEstimatedCost: null,
    evidenceCount,
    retainedBytes,
  };
}
