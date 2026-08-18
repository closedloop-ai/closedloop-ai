import type { Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionDeliveryMetrics } from "@/lib/agent-session-delivery-metrics";
import type { SessionUsageInput } from "./records";

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

/** The in-window API-billed spend the composition root classifies and passes in. */
const WINDOWED_API_COST = 42;

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
const collectOrganizationIds: string[] = [];
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
      (organizationId: string, where: Prisma.SessionDetailWhereInput) => {
        collectOrganizationIds.push(organizationId);
        collectCalls.push(where);
        return Promise.resolve([{ __where: where }]);
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

const { computeDeliverySummaryMetricsWithPrior } = await import(
  "./delivery-metrics"
);

/**
 * The scope/window half of the read: the production caller always passes a prior
 * window explicitly, so these cases pin `null` and assert the current period only.
 */
function computeCurrentDeliveryMetrics(input: SessionUsageInput) {
  return computeDeliverySummaryMetricsWithPrior(input, null, WINDOWED_API_COST);
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
  collectOrganizationIds.length = 0;
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
    // The engine's `where` carries the facet but not the date window.
    expect(call?.where).toMatchObject({ __facet: "codex" });
    expect(
      (call?.where as { __startDate?: string }).__startDate
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
    expect(deliveryCalls.at(-1)?.costUsd).toBe(WINDOWED_API_COST);
    // The stripped scope is still what the merged-PR NUMERATOR is collected over
    // — that half of FEA-4295 is unchanged — so the two are not the same cohort
    // and the cost must not be taken from it.
    expect(
      (deliveryCalls.at(-1)?.where as { __startDate?: string }).__startDate
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
      WINDOWED_API_COST
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
    expect(deliveryCalls[0].costUsd).toBe(WINDOWED_API_COST);
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
        WINDOWED_API_COST
      );

    expect(deliveryCalls).toHaveLength(1);
    expect(priorMergedPrCount).toBeNull();
    expect(metrics.mergedPrCount).toBe(1);
  });
});
