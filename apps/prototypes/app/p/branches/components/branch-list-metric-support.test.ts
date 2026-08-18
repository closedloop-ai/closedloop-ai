import { describe, expect, it } from "vitest";
import {
  compareMetricResults,
  completeMetric,
  noDataMetric,
  notApplicableMetric,
  partialMetric,
  unavailableMetric,
} from "./branch-list-metric-support";
import {
  MetricAvailability,
  MetricDisclosure,
} from "./branch-list-metric-types";

describe("Branch metric comparison table", () => {
  it.each([
    [noDataMetric(), completeMetric(1)],
    [notApplicableMetric(), completeMetric(1)],
    [completeMetric(1), noDataMetric()],
    [completeMetric(1), notApplicableMetric()],
    [completeMetric(1), completeMetric(0)],
  ])("maps undefined comparisons to N/A", (current, prior) => {
    expect(compareMetricResults(current, prior).state).toBe(
      MetricAvailability.NotApplicable
    );
  });

  it.each([
    [partialMetric(1, MetricDisclosure.DefaultIncomplete), completeMetric(1)],
    [completeMetric(1), partialMetric(1, MetricDisclosure.DefaultIncomplete)],
    [unavailableMetric(), completeMetric(1)],
    [completeMetric(1), unavailableMetric()],
  ])("maps incomplete comparisons to unavailable", (current, prior) => {
    expect(compareMetricResults(current, prior).state).toBe(
      MetricAvailability.Unavailable
    );
  });

  it("exports canonical availability literals", () => {
    expect(MetricAvailability.NotApplicable).toBe("not_applicable");
    expect(MetricAvailability.NoData).toBe("no_data");
  });
});
