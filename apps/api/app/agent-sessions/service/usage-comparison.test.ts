import type { Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUsageInput } from "./records";

// The prior-window cohort the module resolved, so the tests can prove it is the
// PRIOR window's own cohort (not the current window's ids re-used) and that every
// other facet rode along unchanged.
const priorCohortInputs: SessionUsageInput[] = [];

vi.mock("./usage-summary-where", () => ({
  buildUsageSummaryWhereParts: vi.fn((input: SessionUsageInput) => {
    priorCohortInputs.push(input);
    return Promise.resolve({
      where: {} as Prisma.SessionDetailWhereInput,
      costMatchedIds: null,
    });
  }),
}));

let priorCostSplit = {
  subscriptionEstimatedCost: 0,
  apiEstimatedCost: 40,
  meteredEstimatedCost: 100,
  unknownEstimatedCost: 0,
};
vi.mock("./usage-cost-split", () => ({
  computeSessionCostSplit: vi.fn(() => Promise.resolve(priorCostSplit)),
}));

let priorAggregate = {
  _count: { _all: 100 },
  _sum: { inputTokens: 150, outputTokens: 50 },
};
vi.mock("@repo/database", () => ({
  withDb: (run: (db: unknown) => unknown) =>
    run({
      sessionDetail: {
        aggregate: () => Promise.resolve(priorAggregate),
        groupBy: () => Promise.resolve([]),
      },
    }),
}));

const { computeUsageComparison, resolvePriorUsageWindow } = await import(
  "./usage-comparison"
);

const CURRENT_START = "2026-07-08T00:00:00.000Z";
const CURRENT_END = "2026-07-14T23:59:59.999Z";

function usageInput(
  filters: Partial<SessionUsageInput["filters"]>
): SessionUsageInput {
  return {
    organizationId: "org-1",
    filters: filters as SessionUsageInput["filters"],
  };
}

const CURRENT_FIGURES = {
  totalSessions: 120,
  totalTokens: 300,
  meteredEstimatedCost: 90,
  apiEstimatedCost: 50,
  mergedPrCount: 6 as number | null,
};

beforeEach(() => {
  priorCohortInputs.length = 0;
  priorAggregate = {
    _count: { _all: 100 },
    _sum: { inputTokens: 150, outputTokens: 50 },
  };
  priorCostSplit = {
    subscriptionEstimatedCost: 0,
    apiEstimatedCost: 40,
    meteredEstimatedCost: 100,
    unknownEstimatedCost: 0,
  };
});

describe("resolvePriorUsageWindow (ISS-5809)", () => {
  it("returns the equal-width window immediately before the current one", () => {
    const prior = resolvePriorUsageWindow(CURRENT_START, CURRENT_END);

    // Adjacent: the prior window ends exactly one millisecond before the current
    // one opens, so the two populations cannot overlap or leave a gap.
    expect(prior?.endDate).toBe("2026-07-07T23:59:59.999Z");
    expect(prior?.startDate).toBe("2026-07-01T00:00:00.000Z");

    // Equal width — the property the comparison's honesty depends on.
    const currentWidth =
      Date.parse(CURRENT_END) - Date.parse(CURRENT_START) + 1;
    const priorWidth =
      Date.parse(prior?.endDate ?? "") - Date.parse(prior?.startDate ?? "") + 1;
    expect(priorWidth).toBe(currentWidth);
  });

  it("keeps equal width for a window that ends mid-day, not on a UTC boundary", () => {
    // The bounds are not whole UTC days here, and the window is fully elapsed, so
    // the prior window is the same width — which is why it is derived from the
    // bounds rather than from a named range.
    const prior = resolvePriorUsageWindow(
      "2026-08-03T00:00:00.000Z",
      "2026-08-10T16:25:26.000Z",
      new Date("2026-08-11T00:00:00.000Z")
    );

    const currentWidth =
      Date.parse("2026-08-10T16:25:26.000Z") -
      Date.parse("2026-08-03T00:00:00.000Z") +
      1;
    const priorWidth =
      Date.parse(prior?.endDate ?? "") - Date.parse(prior?.startDate ?? "") + 1;
    expect(priorWidth).toBe(currentWidth);
    expect(prior?.endDate).toBe("2026-08-02T23:59:59.999Z");
  });

  it("truncates the prior window to the current window's ELAPSED span", () => {
    // The ISS-5809 window ends with the in-progress UTC day, so at 06:00 only 6d
    // 6h of a 7d window has elapsed. A full-width prior window would grade that
    // partial population against a complete one and report the clock as a trend.
    const prior = resolvePriorUsageWindow(
      "2026-08-04T00:00:00.000Z",
      "2026-08-10T23:59:59.999Z",
      new Date("2026-08-10T06:00:00.000Z")
    );

    // Opens one FULL period back, not one elapsed span back: the prior slice must
    // sit at the same phase of the week as the current one, or the comparison
    // trades a partial-vs-complete bias for a weekday/time-of-day one.
    expect(prior?.startDate).toBe("2026-07-28T00:00:00.000Z");
    // ...and closes after the same 6d 6h that has elapsed, not the nominal 7d.
    expect(prior?.endDate).toBe("2026-08-03T06:00:00.000Z");

    const elapsedMs =
      Date.parse("2026-08-10T06:00:00.000Z") -
      Date.parse("2026-08-04T00:00:00.000Z") +
      1;
    const priorWidth =
      Date.parse(prior?.endDate ?? "") - Date.parse(prior?.startDate ?? "") + 1;
    expect(priorWidth).toBe(elapsedMs);
  });

  it("keeps the prior window at the same phase of the period, not merely the same length", () => {
    // The regression this pins: pinning the prior END to the current start and
    // sliding its START forward keeps the length but shifts the slice later in
    // the day, so the prior side loses a weekday morning and gains a weekend
    // night. Both bounds must land exactly one nominal period before their
    // current counterparts.
    const startDate = "2026-08-04T00:00:00.000Z";
    const endDate = "2026-08-10T23:59:59.999Z";
    const now = new Date("2026-08-10T06:00:00.000Z");
    const prior = resolvePriorUsageWindow(startDate, endDate, now);

    const nominalWidthMs = Date.parse(endDate) - Date.parse(startDate) + 1;
    expect(Date.parse(prior?.startDate ?? "")).toBe(
      Date.parse(startDate) - nominalWidthMs
    );
    // The prior window closes at the same offset into its period that `now` sits
    // at in the current one.
    expect(Date.parse(prior?.endDate ?? "")).toBe(
      now.getTime() - nominalWidthMs
    );
  });

  it("leaves a fully-elapsed historical window at its full width", () => {
    // The truncation must not touch a range that has already closed, or every
    // historical comparison would silently narrow.
    const prior = resolvePriorUsageWindow(
      CURRENT_START,
      CURRENT_END,
      new Date("2026-08-10T06:00:00.000Z")
    );

    expect(prior?.endDate).toBe("2026-07-07T23:59:59.999Z");
    expect(prior?.startDate).toBe("2026-07-01T00:00:00.000Z");
  });

  it("declines a window that has not opened yet — nothing has elapsed to compare", () => {
    expect(
      resolvePriorUsageWindow(
        "2026-09-01T00:00:00.000Z",
        "2026-09-07T23:59:59.999Z",
        new Date("2026-08-10T06:00:00.000Z")
      )
    ).toBeNull();
  });

  it("declines an unbounded, malformed, or inverted range", () => {
    expect(resolvePriorUsageWindow(undefined, CURRENT_END)).toBeNull();
    expect(resolvePriorUsageWindow(CURRENT_START, undefined)).toBeNull();
    expect(resolvePriorUsageWindow(undefined, undefined)).toBeNull();
    expect(resolvePriorUsageWindow("not-a-date", CURRENT_END)).toBeNull();
    expect(resolvePriorUsageWindow(CURRENT_END, CURRENT_START)).toBeNull();
  });

  it("declines a bound whose prior window would leave the representable Date range", () => {
    // `isoDateQuerySchema` accepts any finite `Date.parse`, including ECMA-262
    // extended years, so `?comparison=prior&startDate=-271821-04-20T...` reaches
    // here from the wire. Deriving a prior bound below the -8.64e15 floor would
    // throw `RangeError` out of `toISOString` and surface as a 500 labeled
    // "Authentication failed"; the contract is to decline instead.
    const minRepresentable = "-271821-04-20T00:00:00.000Z";
    expect(Number.isFinite(Date.parse(minRepresentable))).toBe(true);
    expect(
      resolvePriorUsageWindow(
        minRepresentable,
        "2026-08-10T23:59:59.999Z",
        new Date("2026-08-10T06:00:00.000Z")
      )
    ).toBeNull();
  });
});

describe("computeUsageComparison (ISS-5809)", () => {
  const priorWindow = {
    startDate: "2026-07-01T00:00:00.000Z",
    endDate: "2026-07-07T23:59:59.999Z",
  };

  it("emits the percent movement for every comparable card", async () => {
    const comparison = await computeUsageComparison({
      input: usageInput({ startDate: CURRENT_START, endDate: CURRENT_END }),
      priorWindow,
      current: CURRENT_FIGURES,
      priorMergedPrCount: 5,
    });

    expect(comparison.deltas).toEqual({
      sessions: 20, // 120 vs 100
      tokens: 50, // 300 vs 200
      meteredCost: -10, // 90 vs 100
      apiCost: 25, // 50 vs 40
      prsShipped: 20, // 6 vs 5
    });
    expect(comparison.priorStartDate).toBe(priorWindow.startDate);
    expect(comparison.priorEndDate).toBe(priorWindow.endDate);
  });

  it("resolves the PRIOR window's own cohort, carrying every other facet", async () => {
    await computeUsageComparison({
      input: usageInput({
        startDate: CURRENT_START,
        endDate: CURRENT_END,
        harness: "claude",
        costBuckets: ["gt_100"],
      }),
      priorWindow,
      current: CURRENT_FIGURES,
      priorMergedPrCount: 5,
    });

    const resolved = priorCohortInputs.at(-1);
    // PLN-1683 M1.2 proposed reusing the CURRENT window's resolved cost-matched
    // ids here. That would scope the prior aggregates to sessions active in the
    // current window and compare the window against itself; the prior period gets
    // its own cohort instead.
    expect(resolved?.filters.startDate).toBe(priorWindow.startDate);
    expect(resolved?.filters.endDate).toBe(priorWindow.endDate);
    // Like-for-like: every non-date filter rides along unchanged, or the two
    // periods would describe different populations.
    expect(resolved?.filters.harness).toBe("claude");
    expect(resolved?.filters.costBuckets).toEqual(["gt_100"]);
  });

  it("omits PRs Shipped when either side has no count — null is not a baseline", async () => {
    const absentPrior = await computeUsageComparison({
      input: usageInput({ startDate: CURRENT_START, endDate: CURRENT_END }),
      priorWindow,
      current: CURRENT_FIGURES,
      priorMergedPrCount: null,
    });
    expect(absentPrior.deltas.prsShipped).toBeUndefined();
    expect("prsShipped" in absentPrior.deltas).toBe(false);

    const absentCurrent = await computeUsageComparison({
      input: usageInput({ startDate: CURRENT_START, endDate: CURRENT_END }),
      priorWindow,
      current: { ...CURRENT_FIGURES, mergedPrCount: null },
      priorMergedPrCount: 5,
    });
    expect(absentCurrent.deltas.prsShipped).toBeUndefined();
    // The other cards still compare — one absent figure suppresses ONLY its card.
    expect(absentCurrent.deltas.sessions).toBe(20);
  });

  it("omits a card whose prior base is too near zero to divide by", async () => {
    priorAggregate = {
      _count: { _all: 0 },
      _sum: { inputTokens: 150, outputTokens: 50 },
    };

    const comparison = await computeUsageComparison({
      input: usageInput({ startDate: CURRENT_START, endDate: CURRENT_END }),
      priorWindow,
      current: CURRENT_FIGURES,
      priorMergedPrCount: 5,
    });

    // A zero prior is not a baseline: no entry rather than an infinite rise.
    expect(comparison.deltas.sessions).toBeUndefined();
    // Its siblings are unaffected.
    expect(comparison.deltas.tokens).toBe(50);
  });
});
