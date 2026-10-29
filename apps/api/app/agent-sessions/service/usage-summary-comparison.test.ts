import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { mocks } from "@/__tests__/support/agent-sessions/service.test-mocks";
import {
  EmissionRollupCause,
  FIXED_WINDOW_EMISSION_WINDOW_MS,
} from "@/lib/observability/fixed-window-emission-throttle";
import { MERGED_PR_DETAIL_WHERE } from "@/lib/session-pr-links";
import { agentSessionsService } from "../service";
import { SESSIONS_USAGE_COMPARISON_LATENCY_METRIC } from "./session-read-metrics";
import { usageComparisonLatencyThrottle } from "./usage-comparison";

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
// Sessions 10 vs 5 and tokens 1,000 vs 500 both double, so each emitted delta is
// +100 and a mis-wired pairing would not land on that number by accident.
//
// ISS-7175: cache is 80% of BOTH token figures on purpose. The tokens delta now
// grades all four counters, and this is the only test that runs the CURRENT
// period's sum (`usage-summary.ts`) rather than passing it in — with a cache-free
// fixture, dropping the cache terms there would still read 200 vs 100 and stay
// green. At this split it reads 200 vs 500 and reports -60 instead of +100.
function installTwoPeriodDb(overrides: Record<string, unknown> = {}) {
  installDb({
    sessionDetail: buildAgentSessionDbMock({
      aggregate: vi
        .fn()
        .mockResolvedValueOnce({
          _count: { _all: 10 },
          _sum: {
            ...emptySums(),
            inputTokens: 100,
            outputTokens: 100,
            cacheReadTokens: 400,
            cacheWriteTokens: 400,
          },
          _min: { sessionStartedAt: new Date(CURRENT_START) },
          _max: { sessionStartedAt: new Date(CURRENT_END) },
        })
        .mockResolvedValueOnce({
          _count: { _all: 5 },
          _sum: {
            inputTokens: 50,
            outputTokens: 50,
            cacheReadTokens: 200,
            cacheWriteTokens: 200,
          },
        }),
      groupBy: vi.fn().mockResolvedValue([]),
    }),
    agentSessionTokenUsage: { groupBy: vi.fn().mockResolvedValue([]) },
    computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    loop: { findMany: vi.fn().mockResolvedValue([]) },
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** The comparison-latency samples this read published, newest last. */
function comparisonLatencySamples(): Record<string, unknown>[] {
  return mocks.emitTelemetryMetric.mock.calls
    .map(([metric]) => metric as Record<string, unknown>)
    .filter(
      (metric) => metric.metric === SESSIONS_USAGE_COMPARISON_LATENCY_METRIC
    );
}

const PRIOR_COMPARISON_FILTERS = {
  startDate: CURRENT_START,
  endDate: CURRENT_END,
  comparison: AgentSessionComparisonMode.Prior,
};

describe("agentSessionsService.getUsageSummary — period comparison (ISS-5809)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The throttle is module state, so it outlives `clearAllMocks` — without
    // this, the first case to emit spends org-1's window budget and every later
    // case reads a suppressed emission as "the code stopped emitting".
    usageComparisonLatencyThrottle.clear();
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

  it("widens the merged-PR read to the prior window the comparison reports", async () => {
    // #7024 review: the delivery read must cover the SAME prior window the fold
    // counts over, or the prior PR count is taken over a set the read cut. This
    // drives the real composition root down to the PR-side query.
    const pullRequestFindMany = vi.fn().mockResolvedValue([]);
    installTwoPeriodDb({
      artifactLink: { findFirst: vi.fn().mockResolvedValue({ id: "link-1" }) },
      pullRequestDetail: { findMany: pullRequestFindMany },
    });

    const summary = await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: PRIOR_COMPARISON_FILTERS,
    });

    expect(pullRequestFindMany).toHaveBeenCalledTimes(1);
    expect(pullRequestFindMany.mock.calls[0]?.[0].where.mergedAt).toEqual({
      ...MERGED_PR_DETAIL_WHERE.mergedAt,
      gte: new Date(summary.comparison?.priorStartDate ?? Number.NaN),
      lte: new Date(CURRENT_END),
    });
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
    // ISS-7422: and it publishes no latency SAMPLE. A rejected read's duration
    // is the time-to-failure, not the time-to-comparison, so folding it into the
    // budget distribution would make a broken cohort resolution read as a fast
    // one — the failure already reaches the monitored path as the log above.
    expect(comparisonLatencySamples()).toHaveLength(0);
    logError.mockRestore();
  });
});

describe("the comparison read's cost (ISS-7422)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The throttle is module state, so it outlives `clearAllMocks` — without
    // this, the first case to emit spends org-1's window budget and every later
    // case reads a suppressed emission as "the code stopped emitting".
    usageComparisonLatencyThrottle.clear();
  });

  /**
   * The reporter asked for two things and the first shipped alone: "these
   * queries need to be faster and we shouldn't have that weird state change."
   *
   * The prior-period read depends on the request's FILTERS, never on the current
   * period's figures — those reach it through a pure fold. It nevertheless ran
   * as its own serial stage after the cost split, the delivery pager and the
   * owner lookup had all settled, so its round trips were ADDED to the request
   * instead of overlapped with it.
   */
  it("issues the prior-period read while the other stage reads are still open", async () => {
    const heldOwners = deferred<unknown[]>();
    let ownerReadSettled = false;
    heldOwners.promise.then(() => {
      ownerReadSettled = true;
    });
    const priorAggregateIssued = deferred<void>();

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        aggregate: vi
          .fn()
          .mockImplementationOnce(() =>
            Promise.resolve({
              _count: { _all: 10 },
              _sum: { ...emptySums(), inputTokens: 100, outputTokens: 100 },
              _min: { sessionStartedAt: new Date(CURRENT_START) },
              _max: { sessionStartedAt: new Date(CURRENT_END) },
            })
          )
          .mockImplementationOnce(() => {
            priorAggregateIssued.resolve();
            return Promise.resolve({
              _count: { _all: 5 },
              _sum: { ...emptySums(), inputTokens: 50, outputTokens: 50 },
            });
          }),
        // Only the Owner facet returns a group, because only the Owner lookup
        // short-circuits on an empty one — this is what gives the stage a read
        // the test can hold open without changing any other population.
        groupBy: vi
          .fn()
          .mockImplementation((args: { by?: string[] }) =>
            Promise.resolve(
              args?.by?.[0] === "userId"
                ? [{ userId: "user-1", _count: { _all: 1 }, _sum: emptySums() }]
                : []
            )
          ),
      }),
      agentSessionTokenUsage: { groupBy: vi.fn().mockResolvedValue([]) },
      computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn(() => heldOwners.promise) },
      loop: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const summaryPromise = agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: PRIOR_COMPARISON_FILTERS,
    });

    // Settles ONLY because the prior read was issued without waiting for the
    // owner read. Serialized behind that stage — where this read used to sit —
    // nothing ever resolves this and the case fails on its explicit timeout.
    await priorAggregateIssued.promise;
    // ...and the read it overlapped is genuinely still open, so this is an
    // overlap rather than a second aggregate that merely ran at some point.
    expect(ownerReadSettled).toBe(false);

    heldOwners.resolve([]);
    const summary = await summaryPromise;
    // The same spy in the opposite state, so the assertion above cannot be
    // passing on a flag that is never written.
    expect(ownerReadSettled).toBe(true);
    // Concurrency changed WHEN the figures are read, never WHICH: 10 vs 5 is
    // still +100%, graded against the same prior window.
    expect(summary.comparison?.deltas.sessions).toBe(100);
  }, 10_000);

  it("measures the comparison read against a published latency budget", async () => {
    installTwoPeriodDb();

    await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: PRIOR_COMPARISON_FILTERS,
    });

    expect(comparisonLatencySamples()).toEqual([
      {
        metric: SESSIONS_USAGE_COMPARISON_LATENCY_METRIC,
        organizationId: "org-1",
        viewerScope: expect.any(String),
        value: expect.any(Number),
        // Pinned as a literal on purpose. Reading the budget from the constant
        // this assertion exists to police would keep the case green through any
        // change to it, including to zero — the duplication IS the test.
        budgetMs: 1500,
      },
    ]);
  });

  it("publishes no comparison-latency sample when no comparison was asked for", async () => {
    installTwoPeriodDb();

    await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: { startDate: CURRENT_START, endDate: CURRENT_END },
    });

    // The negative half of the pair above: one sample per comparison actually
    // read, so the budget distribution is not diluted by reads that never
    // compared at all.
    expect(comparisonLatencySamples()).toHaveLength(0);
  });

  it("bounds the emission to one sample per org window and rolls the suppressed reads up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
      await readComparison();
      await readComparison();

      // The second read of the SAME window emits nothing. Without a bound here,
      // an authenticated caller polling this route drives one emission per
      // request without limit (apps/api/AGENTS.md, "Emission and Abuse Control").
      expect(comparisonLatencySamples()).toHaveLength(1);

      vi.setSystemTime(
        new Date(Date.now() + FIXED_WINDOW_EMISSION_WINDOW_MS + 1)
      );
      await readComparison();

      expect(comparisonLatencySamples()).toEqual([
        expect.objectContaining({ value: expect.any(Number), budgetMs: 1500 }),
        {
          metric: SESSIONS_USAGE_COMPARISON_LATENCY_METRIC,
          organizationId: "org-1",
          viewerScope: expect.any(String),
          // The suppressed read is bounded, not discarded — one rollup carrying
          // the count it stood for, so request volume stays observable.
          occurrences: 1,
          // No `value`: these reads shared no single duration, and publishing
          // one would put a fabricated latency on the samples' own metric name.
          aggregated: true,
          flushedBy: EmissionRollupCause.Window,
        },
        expect.objectContaining({ value: expect.any(Number), budgetMs: 1500 }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * One comparison-enabled summary read for `org-1`, on its own DB fixture — the
 * shared one is `mockResolvedValueOnce` per period, so a case that reads more
 * than once must re-arm it rather than fall off the end of the queue.
 */
function readComparison() {
  installTwoPeriodDb();
  return agentSessionsService.getUsageSummary({
    organizationId: "org-1",
    filters: PRIOR_COMPARISON_FILTERS,
  });
}
