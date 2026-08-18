import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

const CURRENT_START = "2026-07-08T00:00:00.000Z";
const CURRENT_END = "2026-07-14T23:59:59.999Z";

function emptySums() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0,
  };
}

// The current-period aggregate resolves first, the prior-period aggregate second.
// Sessions 10 vs 5 and tokens 200 vs 100 both double, so each emitted delta is
// +100 and a mis-wired pairing would not land on that number by accident.
function installTwoPeriodDb() {
  installDb({
    sessionDetail: buildAgentSessionDbMock({
      aggregate: vi
        .fn()
        .mockResolvedValueOnce({
          _count: { _all: 10 },
          _sum: { ...emptySums(), inputTokens: 100, outputTokens: 100 },
          _min: { sessionStartedAt: new Date(CURRENT_START) },
          _max: { sessionStartedAt: new Date(CURRENT_END) },
        })
        .mockResolvedValueOnce({
          _count: { _all: 5 },
          _sum: { inputTokens: 50, outputTokens: 50 },
        }),
      groupBy: vi.fn().mockResolvedValue([]),
    }),
    agentSessionTokenUsage: { groupBy: vi.fn().mockResolvedValue([]) },
    computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    loop: { findMany: vi.fn().mockResolvedValue([]) },
  });
}

describe("agentSessionsService.getUsageSummary — period comparison (ISS-5809)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("OMITS the comparison entirely when the caller did not opt in", async () => {
    installTwoPeriodDb();

    const summary = await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: { startDate: CURRENT_START, endDate: CURRENT_END },
    });

    expect(summary.comparison).toBeUndefined();
    // Absent, not null: an unset optional field is never serialized as null, so a
    // client that does not know this contract sees no comparison at all.
    expect("comparison" in summary).toBe(false);
  });

  it("computes the comparison against the equal-width prior window when opted in", async () => {
    installTwoPeriodDb();

    const summary = await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: {
        startDate: CURRENT_START,
        endDate: CURRENT_END,
        comparison: AgentSessionComparisonMode.Prior,
      },
    });

    expect(summary.comparison?.priorStartDate).toBe("2026-07-01T00:00:00.000Z");
    expect(summary.comparison?.priorEndDate).toBe("2026-07-07T23:59:59.999Z");
    expect(summary.comparison?.deltas.sessions).toBe(100);
    expect(summary.comparison?.deltas.tokens).toBe(100);
    // No cost rows and no merged PRs in this fixture, so those cards have no
    // honest baseline and get no entry rather than a fabricated 0%.
    expect(summary.comparison?.deltas.meteredCost).toBeUndefined();
    expect(summary.comparison?.deltas.prsShipped).toBeUndefined();
  });

  it("omits the comparison on an unbounded range, which has no prior window", async () => {
    installTwoPeriodDb();

    const summary = await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: { comparison: AgentSessionComparisonMode.Prior },
    });

    expect(summary.comparison).toBeUndefined();
  });

  it("still answers with the current summary when the PRIOR read fails", async () => {
    // The comparison is an optional field on an otherwise-complete payload, so a
    // failed prior read must cost the reader the chips, never the headline cards.
    // Before ISS-5809 folded this server-side the prior read was a separate client
    // request and could only ever blank the chips; awaiting it unguarded here gave
    // it veto power over aggregates that had already succeeded.
    installDb({
      sessionDetail: buildAgentSessionDbMock({
        aggregate: vi
          .fn()
          .mockResolvedValueOnce({
            _count: { _all: 10 },
            _sum: { ...emptySums(), inputTokens: 100, outputTokens: 100 },
            _min: { sessionStartedAt: new Date(CURRENT_START) },
            _max: { sessionStartedAt: new Date(CURRENT_END) },
          })
          .mockRejectedValueOnce(new Error("statement timeout")),
        groupBy: vi.fn().mockResolvedValue([]),
      }),
      agentSessionTokenUsage: { groupBy: vi.fn().mockResolvedValue([]) },
      computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      loop: { findMany: vi.fn().mockResolvedValue([]) },
    });
    const logError = vi.spyOn(log, "error").mockImplementation(() => undefined);

    const summary = await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: {
        startDate: CURRENT_START,
        endDate: CURRENT_END,
        comparison: AgentSessionComparisonMode.Prior,
      },
    });

    // The current period survived intact — this is the half the reader loses if
    // the prior read is allowed to reject the response.
    expect(summary.totalSessions).toBe(10);
    expect(summary.totalInputTokens).toBe(100);
    expect(summary.totalOutputTokens).toBe(100);
    // ...and the comparison degrades to the same absence the contract already
    // defines, rather than a partial or fabricated one.
    expect(summary.comparison).toBeUndefined();
    expect("comparison" in summary).toBe(false);
    // Degraded, not swallowed: a prior read failing while the current one
    // succeeds is a real defect, so it reaches the monitored server path.
    expect(logError).toHaveBeenCalledWith(
      "Sessions usage prior-period comparison failed",
      expect.objectContaining({ organizationId: "org-1" })
    );
    logError.mockRestore();
  });
});
