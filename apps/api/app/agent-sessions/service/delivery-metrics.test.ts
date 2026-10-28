import type { Prisma } from "@repo/database";
import type { LimitFunction } from "p-limit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionDeliveryMetrics } from "@/lib/agent-session-delivery-metrics";
import { createDbFanoutLimiter } from "@/lib/db-fanout";
import { MergedPrBranchAdmissionKind } from "@/lib/session-pr-links";
import type { NumeratorBranchCohort } from "./loc-per-dollar-coverage";
import type { SessionUsageInput } from "./records";
import type { UsageComparisonWindow } from "./usage-comparison";

// Capture the `where` and window handed to the delivery engine, plus the `where`
// each collaborator receives, so the tests can assert the SCOPE (session-activity
// date window stripped, FEA-4295) and the IN-WINDOW cost denominator (ISS-6398).
type DeliveryCall = {
  where: Prisma.SessionDetailWhereInput;
  costUsd: number | null;
  mergeWindow: { start: number; end: number } | null;
};
const deliveryCalls: DeliveryCall[] = [];
const usageWhereInputs: SessionUsageInput[] = [];

/** The in-window total spend the composition root classifies and passes in. */
const WINDOWED_TOTAL_COST = 42;

// `buildUsageSummaryWhere` echoes the (possibly date-stripped) filters back as a
// sentinel `where` so the test can prove which filters reached the scope builder.
vi.mock("./usage-summary-where", () => ({
  buildUsageSummaryWhere: vi.fn((input: SessionUsageInput) => {
    usageWhereInputs.push(input);
    return Promise.resolve({
      __startDate: input.filters.startDate,
      __endDate: input.filters.endDate,
      __facet: input.filters.harness,
    } as unknown as Prisma.SessionDetailWhereInput);
  }),
}));

// ISS-5809 split the adapter into a window-INDEPENDENT collection pass and a
// per-window compute, so the mock follows that seam. The collector returns a
// sentinel "PR" carrying the scope it was called with; the compute reads that
// sentinel back out, which is what lets these tests keep asserting the delivery
// `where` AND lets the two-window test prove both windows evaluated the SAME
// collected set.
const collectCalls: Prisma.SessionDetailWhereInput[] = [];
/** ISS-9924: the `mergedAt` span each collection pass was bounded to. */
const collectReadWindows: ({ start: number; end: number } | null)[] = [];
const collectOrganizationIds: string[] = [];
/** ISS-6136: the fan-out limiter each downstream read was handed, if any. */
const collectLimiters: (LimitFunction | undefined)[] = [];
const coverageLimiters: (LimitFunction | undefined)[] = [];
type SentinelPr = { __where: Prisma.SessionDetailWhereInput };

vi.mock("@/lib/agent-session-delivery-metrics", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/agent-session-delivery-metrics")
  >("@/lib/agent-session-delivery-metrics");
  return {
    ...actual,
    // ISS-6028 threads the org id ahead of the scope so the PR-side read is
    // org-scoped in the statement; the scope this suite asserts on is the
    // SECOND argument.
    collectMergedPrsForScope: vi.fn(
      (
        organizationId: string,
        where: Prisma.SessionDetailWhereInput,
        mergedWithin: { start: number; end: number } | null = null,
        limiter?: LimitFunction
      ) => {
        collectOrganizationIds.push(organizationId);
        collectCalls.push(where);
        collectReadWindows.push(mergedWithin);
        collectLimiters.push(limiter);
        return Promise.resolve({
          prs: [{ __where: where }],
          // ISS-7705: one admitted merged PR on a known branch, merged at the
          // START bound so it lands inside every window these cases select.
          mergedBranches: [
            {
              branchArtifactId: MERGED_BRANCH_ID,
              mergedAtMs: Date.parse(START),
              admissionKind: MergedPrBranchAdmissionKind.ExactIdentity,
              prIdentity: MERGED_PR_IDENTITY,
            },
          ],
        });
      }
    ),
    computeDeliveryMetricsFromPrs: vi.fn(
      (
        prs: SentinelPr[],
        costUsd: number | null,
        mergeWindow: { start: number; end: number } | null
      ): AgentSessionDeliveryMetrics => {
        deliveryCalls.push({ where: prs[0].__where, costUsd, mergeWindow });
        return {
          mergedPrCount: 1,
          medianPrSize: null,
          mergedLocPerDollar: null,
        };
      }
    ),
  };
});

// ISS-7705: `collectDeliveryPrScope` now also probes LOC/$ coverage once the
// scope has merged PRs. This suite is about the SCOPE and the merge WINDOW, not
// the coverage read, so the probe is stubbed to keep these cases off the
// database — `loc-per-dollar-coverage.test.ts` owns its behavior.
const coverageDenominatorWheres: Prisma.SessionDetailWhereInput[] = [];
const coverageCohorts: NumeratorBranchCohort[] = [];
/** The branch artifact the mocked merged PR is admitted against. */
const MERGED_BRANCH_ID = "branch-artifact-merged";
/** The identity that admitted it — what keeps a reused branch's other PR out. */
const MERGED_PR_IDENTITY = "acme/repo#7";
vi.mock("./loc-per-dollar-coverage", async () => {
  const actual = await vi.importActual<
    typeof import("./loc-per-dollar-coverage")
  >("./loc-per-dollar-coverage");
  return {
    ...actual,
    readLocPerDollarCoverageCounts: vi.fn(
      (
        _organizationId: string,
        cohort: NumeratorBranchCohort,
        _deliveryWhere: Prisma.SessionDetailWhereInput,
        denominatorWhere: Prisma.SessionDetailWhereInput,
        limiter?: LimitFunction
      ) => {
        coverageCohorts.push(cohort);
        coverageDenominatorWheres.push(denominatorWhere);
        coverageLimiters.push(limiter);
        return Promise.resolve({
          numeratorSessionCount: 0,
          coveredNumeratorSessionCount: 0,
          migrationPendingSessionCount: 0,
          unrevisionedSessionCount: 0,
        });
      }
    ),
  };
});

/** The denominator `where` these cases hand the scope; asserted in one case. */
const DENOMINATOR_WHERE: Prisma.SessionDetailWhereInput = {
  artifact: { organizationId: "org_denominator_sentinel" },
};

const { collectDeliveryPrScope, foldDeliverySummaryMetricsWithPrior } =
  await import("./delivery-metrics");

/**
 * ISS-7343 split the read into a DB half and a pure fold so the usage composition
 * root can run the scan concurrently with the cost split. These cases exercise the
 * two exactly as that root composes them, so the assertions below still describe
 * one production read.
 */
async function computeDeliverySummaryMetricsWithPrior(
  input: SessionUsageInput,
  priorWindow: UsageComparisonWindow | null,
  windowedApiCost: number | null
) {
  return foldDeliverySummaryMetricsWithPrior(
    await collectDeliveryPrScope(input, DENOMINATOR_WHERE, priorWindow),
    priorWindow,
    windowedApiCost
  );
}

/**
 * The scope/window half of the read: the production caller always passes a prior
 * window explicitly, so these cases pin `null` and assert the current period only.
 */
function computeCurrentDeliveryMetrics(input: SessionUsageInput) {
  return computeDeliverySummaryMetricsWithPrior(
    input,
    null,
    WINDOWED_TOTAL_COST
  );
}

const START = "2026-07-01T00:00:00Z";
const END = "2026-07-31T23:59:59Z";

function usageInput(
  filters: Partial<SessionUsageInput["filters"]>
): SessionUsageInput {
  return {
    organizationId: "org-1",
    filters: filters as SessionUsageInput["filters"],
  };
}

beforeEach(() => {
  deliveryCalls.length = 0;
  usageWhereInputs.length = 0;
  collectCalls.length = 0;
  collectReadWindows.length = 0;
  collectOrganizationIds.length = 0;
  collectLimiters.length = 0;
  coverageLimiters.length = 0;
});

describe("delivery scope (FEA-4295)", () => {
  it("STRIPS the session-activity date window from the delivery scope so an older-than-window session's in-window merge is reachable", async () => {
    await computeCurrentDeliveryMetrics(
      usageInput({ startDate: START, endDate: END, harness: "claude" })
    );

    // The scope builder was invoked with the date bounds removed (so the scan is
    // NOT pre-windowed on session activity)…
    const scopeInput = usageWhereInputs.at(-1);
    expect(scopeInput?.filters.startDate).toBeUndefined();
    expect(scopeInput?.filters.endDate).toBeUndefined();
    // …but every OTHER facet is preserved.
    expect(scopeInput?.filters.harness).toBe("claude");

    // The selected range is passed to the engine as the merge window (applied at
    // `mergedAt`), NOT as a session-activity filter.
    expect(deliveryCalls.at(-1)?.mergeWindow).toEqual({
      start: Date.parse(START),
      end: Date.parse(END),
    });
  });

  it("passes the delivery `where` unmodified (facets preserved) to the engine", async () => {
    await computeCurrentDeliveryMetrics(
      usageInput({ startDate: START, endDate: END, harness: "codex" })
    );

    const call = deliveryCalls.at(-1);
    if (!call) {
      throw new Error("the delivery engine was never called");
    }
    // The engine's `where` carries the facet but not the date window.
    expect(call.where).toMatchObject({ __facet: "codex" });
    expect(
      (call.where as { __startDate?: string }).__startDate
    ).toBeUndefined();
    // ISS-6028: the caller's org is threaded alongside that scope, so the
    // PR-side read is tenant-scoped in the statement and not only through the
    // session join.
    expect(collectOrganizationIds.at(-1)).toBe("org-1");
  });

  it("divides by the caller's IN-WINDOW spend, never a cost re-derived over the date-window-stripped scope (ISS-6398)", async () => {
    await computeCurrentDeliveryMetrics(
      usageInput({ startDate: START, endDate: END, harness: "claude" })
    );

    // The denominator is the spend of the SELECTED window, handed in by the
    // composition root — the same figure its Cost card renders. Before ISS-6398
    // this module ran its own cost split over the stripped scope below, so a 7d
    // view divided in-window merged lines by all-time spend.
    const call = deliveryCalls.at(-1);
    if (!call) {
      throw new Error("the delivery engine was never called");
    }
    expect(call.costUsd).toBe(WINDOWED_TOTAL_COST);
    // The stripped scope is still what the merged-PR NUMERATOR is collected over
    // — that half of FEA-4295 is unchanged — so the two are not the same cohort
    // and the cost must not be taken from it.
    expect(
      (call.where as { __startDate?: string }).__startDate
    ).toBeUndefined();
  });

  it("with NO date range selected reuses the usage `where` as-is and passes a null (all-time) window", async () => {
    await computeCurrentDeliveryMetrics(usageInput({ harness: "claude" }));

    // No stripping needed — the scope has no date window to begin with.
    expect(usageWhereInputs.at(-1)?.filters.harness).toBe("claude");
    expect(deliveryCalls.at(-1)?.mergeWindow).toBeNull();
  });
});

describe("computeDeliverySummaryMetricsWithPrior — prior merged-PR count (ISS-5809)", () => {
  const PRIOR = {
    startDate: "2026-06-01T00:00:00Z",
    endDate: "2026-06-30T23:59:59Z",
  };

  it("collects the merged-PR set ONCE and evaluates it against both windows", async () => {
    const { priorMergedPrCount } = await computeDeliverySummaryMetricsWithPrior(
      usageInput({ startDate: START, endDate: END, harness: "claude" }),
      PRIOR,
      WINDOWED_TOTAL_COST
    );

    // The expensive half ran once — this is the whole reason the prior count is
    // free. A second collection here would mean a second probe + keyset pager.
    expect(collectCalls).toHaveLength(1);
    // …and the cheap half ran twice, over that one collected set.
    expect(deliveryCalls).toHaveLength(2);
    expect(deliveryCalls[0].where).toBe(deliveryCalls[1].where);
    // ISS-6398: the in-window spend belongs to the CURRENT window only. The prior
    // evaluation (from which just `mergedPrCount` is read) gets a null
    // denominator, so a prior LOC/$ built on current dollars cannot exist.
    expect(deliveryCalls[0].costUsd).toBe(WINDOWED_TOTAL_COST);
    expect(deliveryCalls[1].costUsd).toBeNull();

    expect(deliveryCalls[0].mergeWindow).toEqual({
      start: Date.parse(START),
      end: Date.parse(END),
    });
    expect(deliveryCalls[1].mergeWindow).toEqual({
      start: Date.parse(PRIOR.startDate),
      end: Date.parse(PRIOR.endDate),
    });
    expect(priorMergedPrCount).toBe(1);
  });

  it("computes no prior count, and no second window, when no prior window is given", async () => {
    const { metrics, priorMergedPrCount } =
      await computeDeliverySummaryMetricsWithPrior(
        usageInput({ startDate: START, endDate: END }),
        null,
        WINDOWED_TOTAL_COST
      );

    expect(deliveryCalls).toHaveLength(1);
    expect(priorMergedPrCount).toBeNull();
    expect(metrics.mergedPrCount).toBe(1);
  });

  it("hands the coverage probe the caller's denominator where, not the delivery scope (ISS-7705)", async () => {
    coverageDenominatorWheres.length = 0;
    coverageCohorts.length = 0;
    const input = usageInput({ startDate: START, endDate: END });

    const scope = await collectDeliveryPrScope(input, DENOMINATOR_WHERE, null);

    // The probe must measure against the predicate the DIVISOR is summed over.
    // Handing it the delivery scope instead would compare the numerator cohort
    // to itself and report `complete` for every read.
    expect(coverageDenominatorWheres).toEqual([DENOMINATOR_WHERE]);
    // And the cohort is the branch of the merged PR the lines came from, not
    // "every session that ever carried a PR link".
    expect(coverageCohorts).toHaveLength(1);
    expect([...(coverageCohorts[0]?.keys() ?? [])]).toEqual([MERGED_BRANCH_ID]);
    // ISS-7705: and it carries the identity that admitted the PR, so a reused
    // branch's other PR cannot pull its sessions into the numerator cohort.
    expect([
      ...(coverageCohorts[0]?.get(MERGED_BRANCH_ID)?.identities ?? []),
    ]).toEqual([MERGED_PR_IDENTITY]);
    // And the delivery scope it was paired with is the date-window-STRIPPED one,
    // which is what makes the two populations differ in the first place.
    expect(collectCalls.at(-1)).not.toEqual(DENOMINATOR_WHERE);
    expect(scope.coverageProbed).toBe(true);
    expect(scope.coverageCounts).not.toBeNull();
  });

  it("hands BOTH stage-2 reads the caller's one limiter, not a budget each (ISS-6136)", async () => {
    // Call bounds compose by ADDITION. Before ISS-6136 both chunk loops peaked
    // at 1, so a budget each cost nothing; now that they fan out, a dropped
    // pass-through means this stage runs on two or three ceilings instead of
    // the one its caller opened. That these two reads happen not to overlap
    // today is an ordering detail of this function, not a bound, so the
    // assertion is on the ARGUMENT rather than on an observed peak.
    const limiter = createDbFanoutLimiter();

    await collectDeliveryPrScope(
      usageInput({ startDate: START, endDate: END }),
      DENOMINATOR_WHERE,
      null,
      limiter
    );

    expect(collectLimiters).toEqual([limiter]);
    expect(coverageLimiters).toEqual([limiter]);
  });

  it("leaves each read to open its own budget when the caller has none", async () => {
    await collectDeliveryPrScope(
      usageInput({ startDate: START, endDate: END }),
      DENOMINATOR_WHERE,
      null
    );

    expect(collectLimiters).toEqual([undefined]);
    expect(coverageLimiters).toEqual([undefined]);
  });
});

describe("delivery read window (ISS-9924)", () => {
  it("bounds the merged-PR read to the span of the current and prior windows the folds evaluate", async () => {
    const priorWindow = {
      startDate: "2026-06-01T00:00:00.000Z",
      endDate: "2026-06-30T23:59:59.000Z",
    };

    await computeDeliverySummaryMetricsWithPrior(
      usageInput({ startDate: START, endDate: END }),
      priorWindow,
      WINDOWED_TOTAL_COST
    );

    expect(collectReadWindows).toEqual([
      { start: Date.parse(priorWindow.startDate), end: Date.parse(END) },
    ]);
  });

  it("bounds the read to the current window alone when no prior window is compared", async () => {
    await computeCurrentDeliveryMetrics(
      usageInput({ startDate: START, endDate: END })
    );

    expect(collectReadWindows).toEqual([
      { start: Date.parse(START), end: Date.parse(END) },
    ]);
  });

  it("keeps the all-time read when the current range is unbounded", async () => {
    await computeDeliverySummaryMetricsWithPrior(
      usageInput({}),
      { startDate: START, endDate: END },
      WINDOWED_TOTAL_COST
    );

    expect(collectReadWindows).toEqual([null]);
  });
});
