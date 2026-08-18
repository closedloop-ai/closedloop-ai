import { InsightsPeriod } from "@closedloop-ai/loops-api/insights";
import { InsightsScope } from "@repo/api/src/types/insights";
import {
  LostWorkWidget,
  TokenOpsWidget,
} from "@repo/api/src/types/session-analytics";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A widget whose read fails must SETTLE as unavailable — reported in
 * `unavailableWidgets` so the screen renders a dash with a reason — and must
 * never degrade into a fabricated `0`.
 *
 * On surfaces whose whole subject is failure, a `0` reads as "no problem here",
 * which is a worse outcome than showing nothing. A sibling widget's failure
 * must also never take the rest of the page down with it.
 */

const mocks = vi.hoisted(() => ({
  fetchLossGrid: vi.fn(),
  fetchLossPersonGrid: vi.fn(),
  fetchLossTrendGrid: vi.fn(),
  fetchLostSessionCandidates: vi.fn(),
  fetchModelMedianTokens: vi.fn(),
  fetchModelSpendGrid: vi.fn(),
  fetchSpendGrid: vi.fn(),
  logError: vi.fn(),
  sessionScopeSql: vi.fn(() => "SCOPE"),
}));

vi.mock("./lost-work-queries", () => ({
  fetchLossGrid: mocks.fetchLossGrid,
  fetchLossPersonGrid: mocks.fetchLossPersonGrid,
  fetchLossTrendGrid: mocks.fetchLossTrendGrid,
  fetchLostSessionCandidates: mocks.fetchLostSessionCandidates,
}));

vi.mock("./tokenops-waste-queries", () => ({
  fetchModelMedianTokens: mocks.fetchModelMedianTokens,
  fetchModelSpendGrid: mocks.fetchModelSpendGrid,
  fetchSpendGrid: mocks.fetchSpendGrid,
}));

/**
 * `start` and `trendStart` are deliberately DIFFERENT here, the way
 * `resolvePeriodRange` returns them for period "all" (start = epoch,
 * trendStart = end - 90d). A mock that collapsed them could not see a widget
 * reading the wrong one.
 */
const RANGE_START_OFFSET_MS = 86_400_000;
const TREND_START_OFFSET_MS = 90 * 86_400_000;

vi.mock("./service", () => ({
  resolvePeriodRange: (_period: string, now: Date) => ({
    end: now,
    priorStart: null,
    start: new Date(now.getTime() - 86_400_000),
    trendStart: new Date(now.getTime() - 90 * 86_400_000),
  }),
  sessionScopeSql: mocks.sessionScopeSql,
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError, info: vi.fn(), warn: vi.fn() },
}));

const { fetchLostWork } = await import("./lost-work");
const { fetchTokenOpsWaste } = await import("./tokenops-waste");

const CTX = {
  organizationId: "org-1",
  scope: InsightsScope.Org,
  userId: "user-1",
};
const NOW = new Date("2026-08-01T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionScopeSql.mockReturnValue("SCOPE");
});

describe("lost-work reads every per-session widget over the window it reports", () => {
  it("fetches the per-engineer grid over the TOTALS window, not the trend window", async () => {
    mocks.fetchLossGrid.mockResolvedValue([]);
    mocks.fetchLossTrendGrid.mockResolvedValue({
      bucketedZone: undefined,
      rows: [],
    });
    mocks.fetchLossPersonGrid.mockResolvedValue([]);
    mocks.fetchLostSessionCandidates.mockResolvedValue([]);

    await fetchLostWork(CTX, InsightsPeriod.Month, NOW);

    const expectedStart = new Date(NOW.getTime() - RANGE_START_OFFSET_MS);
    const expectedTrendStart = new Date(NOW.getTime() - TREND_START_OFFSET_MS);

    // The per-engineer table sits directly under the attribution strip and
    // appears to decompose it. Reading the longer trend window here made the
    // person rows cover 90 days under an all-time headline, with no date axis
    // to reveal the narrower window.
    const [, personStart, personEnd] =
      mocks.fetchLossPersonGrid.mock.calls[0] ?? [];
    expect(personStart).toEqual(expectedStart);
    expect(personEnd).toEqual(NOW);

    const [, totalsStart] = mocks.fetchLossGrid.mock.calls[0] ?? [];
    expect(totalsStart).toEqual(expectedStart);

    // The trend chart is the one widget that legitimately reads the longer
    // window, because it draws the axis that explains it.
    const [, trendStart] = mocks.fetchLossTrendGrid.mock.calls[0] ?? [];
    expect(trendStart).toEqual(expectedTrendStart);
  });
});

describe("lost-work degrades one widget at a time", () => {
  it("reports the failed widget and still renders the ones that resolved", async () => {
    mocks.fetchLossGrid.mockResolvedValue([
      {
        endsWithError: true,
        hasWallClock: true,
        minutes: 120,
        producedArtifact: false,
        sessions: 2,
        state: "ERROR",
        throttleSource: null,
      },
    ]);
    mocks.fetchLossTrendGrid.mockRejectedValue(new Error("trend read failed"));
    mocks.fetchLossPersonGrid.mockResolvedValue([]);
    mocks.fetchLostSessionCandidates.mockResolvedValue([]);

    const result = await fetchLostWork(CTX, InsightsPeriod.Month, NOW);

    expect(result.unavailableWidgets).toContain(LostWorkWidget.Trend);
    // The widgets that resolved still carry their real values.
    expect(result.totals.minutesByClass.actionable).toBe(120);
    expect(result.unavailableWidgets).not.toContain(LostWorkWidget.Totals);
    expect(mocks.logError).toHaveBeenCalledWith(
      "insights.session_analytics_widget_failed",
      expect.objectContaining({ widget: LostWorkWidget.Trend })
    );
  });

  it("marks the totals and both cause lists unavailable together when their shared read fails", async () => {
    mocks.fetchLossGrid.mockRejectedValue(new Error("grid read failed"));
    mocks.fetchLossTrendGrid.mockResolvedValue({
      bucketedZone: undefined,
      rows: [],
    });
    mocks.fetchLossPersonGrid.mockResolvedValue([]);
    mocks.fetchLostSessionCandidates.mockResolvedValue([]);

    const result = await fetchLostWork(CTX, InsightsPeriod.Month, NOW);

    // They are one rollup read, so one of them cannot silently render an empty
    // list that would read as "no failures here".
    expect(result.unavailableWidgets).toEqual(
      expect.arrayContaining([
        LostWorkWidget.Totals,
        LostWorkWidget.SystemicCauses,
        LostWorkWidget.BehavioralCauses,
      ])
    );
    expect(result.systemicCauses).toEqual([]);
  });
});

describe("tokenops degrades without fabricating a dollar figure", () => {
  it("marks the waste estimate unavailable when the spend read fails", async () => {
    mocks.fetchSpendGrid.mockRejectedValue(new Error("spend read failed"));
    mocks.fetchModelSpendGrid.mockResolvedValue([]);
    mocks.fetchModelMedianTokens.mockResolvedValue([]);

    const result = await fetchTokenOpsWaste(CTX, InsightsPeriod.Month, NOW);

    expect(result.unavailableWidgets).toEqual(
      expect.arrayContaining([TokenOpsWidget.Outcomes, TokenOpsWidget.Waste])
    );
    // The screen must read this as "unavailable", never as "$0 was wasted".
    expect(result.outcomes).toEqual([]);
  });

  it("keeps the outcome split when only the model table fails", async () => {
    mocks.fetchSpendGrid.mockResolvedValue([
      {
        endsWithError: true,
        hasWallClock: true,
        producedArtifact: false,
        sessions: 3,
        usd: 90,
      },
    ]);
    mocks.fetchModelSpendGrid.mockRejectedValue(new Error("model read failed"));
    mocks.fetchModelMedianTokens.mockResolvedValue([]);

    const result = await fetchTokenOpsWaste(CTX, InsightsPeriod.Month, NOW);

    expect(result.unavailableWidgets).toContain(TokenOpsWidget.Models);
    expect(result.unavailableWidgets).not.toContain(TokenOpsWidget.Outcomes);
    expect(result.totalSpendUsd).toBeCloseTo(90, 2);
    expect(result.waste.errorOutcomeUsd).toBeCloseTo(90, 2);
  });

  it("reports a genuine zero when the reads succeed and there was no failed spend", async () => {
    mocks.fetchSpendGrid.mockResolvedValue([
      {
        endsWithError: false,
        hasWallClock: true,
        producedArtifact: true,
        sessions: 4,
        usd: 120,
      },
    ]);
    mocks.fetchModelSpendGrid.mockResolvedValue([]);
    mocks.fetchModelMedianTokens.mockResolvedValue([]);

    const result = await fetchTokenOpsWaste(CTX, InsightsPeriod.Month, NOW);

    // Nothing failed and nothing is unavailable, so this 0 is a measurement.
    expect(result.unavailableWidgets).toEqual([]);
    expect(result.waste.errorOutcomeUsd).toBe(0);
    expect(result.totalSpendUsd).toBeCloseTo(120, 2);
  });
});
