import { describe, expect, it } from "vitest";
import {
  BRANCH_METRIC_FIXTURE_NOW,
  branchPrototypeReviewFixture,
} from "./components/branch-list-fixtures";
import { MetricAvailability } from "./components/branch-list-metric-types";
import { calculateBranchListMetrics } from "./components/branch-list-metrics";
import { DateRange } from "./mock";

describe("Branch summary fixture", () => {
  it("reconciles active branches through the derived metric producer", () => {
    const metrics = calculateBranchListMetrics(
      branchPrototypeReviewFixture.rows.map(({ id }) => id),
      branchPrototypeReviewFixture.evidence,
      DateRange.All,
      BRANCH_METRIC_FIXTURE_NOW
    );

    expect(metrics.activeBranches.current.state).toBe(
      MetricAvailability.Complete
    );
    expect(metrics.activeBranches.current.value).toBeGreaterThan(0);
  });
});
