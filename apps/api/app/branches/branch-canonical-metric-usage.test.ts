import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setAppSpanAttributes: vi.fn(),
  withAppSpan: vi.fn((_name: string, callback: () => unknown) => callback()),
}));

vi.mock("@repo/observability/tracing/spans", () => ({
  setAppSpanAttributes: mocks.setAppSpanAttributes,
  withAppSpan: mocks.withAppSpan,
}));

import { resolveCanonicalMetricCohort } from "./branch-canonical-metric-usage";

describe("resolveCanonicalMetricCohort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records the canonical cohort span without reloading unbounded queries", async () => {
    const rows = [{ id: "branch-a" }];
    const loadNonDateCohort = vi.fn();

    await expect(
      resolveCanonicalMetricCohort({}, rows, loadNonDateCohort)
    ).resolves.toBe(rows);

    expect(mocks.withAppSpan).toHaveBeenCalledWith(
      "branches.analytics.canonical_cohort.resolve",
      expect.any(Function)
    );
    expect(loadNonDateCohort).not.toHaveBeenCalled();
    expect(mocks.setAppSpanAttributes).toHaveBeenCalledWith({
      "branches.analytics.canonical_cohort.date_bounded": false,
      "branches.analytics.canonical_cohort.windowed_row_count": 1,
      "branches.analytics.canonical_cohort.reloaded": false,
    });
  });

  it("records the canonical cohort span around date-window reloads", async () => {
    const rows = [{ id: "branch-a" }];
    const canonicalRows = [{ id: "branch-a" }, { id: "branch-b" }];
    const loadNonDateCohort = vi.fn(async () => canonicalRows);

    await expect(
      resolveCanonicalMetricCohort(
        {
          endDate: new Date("2026-08-22T00:00:00.000Z"),
          repository: "closedloop-ai/closedloop-ai",
          startDate: new Date("2026-08-15T00:00:00.000Z"),
        },
        rows,
        loadNonDateCohort
      )
    ).resolves.toBe(canonicalRows);

    expect(mocks.withAppSpan).toHaveBeenCalledWith(
      "branches.analytics.canonical_cohort.resolve",
      expect.any(Function)
    );
    expect(loadNonDateCohort).toHaveBeenCalledWith({
      endDate: undefined,
      repository: "closedloop-ai/closedloop-ai",
      startDate: undefined,
    });
    expect(mocks.setAppSpanAttributes).toHaveBeenCalledWith({
      "branches.analytics.canonical_cohort.date_bounded": true,
      "branches.analytics.canonical_cohort.windowed_row_count": 1,
      "branches.analytics.canonical_cohort.reloaded": true,
    });
  });
});
