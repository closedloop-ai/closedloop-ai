import { describe, expect, test } from "vitest";
import { createMockMetricStatistics } from "@/__tests__/fixtures/evaluation";
import {
  calculateAcceptanceRate,
  sortMetricsByScore,
} from "../evaluation-utils";

describe("calculateAcceptanceRate", () => {
  test("returns zero rate for undefined metrics", () => {
    const result = calculateAcceptanceRate(undefined);
    expect(result).toEqual({
      acceptedCount: 0,
      totalCount: 0,
      rate: 0,
    });
  });

  test("returns zero rate for empty metrics array", () => {
    const result = calculateAcceptanceRate([]);
    expect(result).toEqual({
      acceptedCount: 0,
      totalCount: 0,
      rate: 0,
    });
  });

  test("uses score >= threshold logic for acceptance", () => {
    const metrics = [
      createMockMetricStatistics({
        metric_name: "metric1",
        score: 0.8,
        threshold: 0.8,
      }), // Pass: equal
      createMockMetricStatistics({
        metric_name: "metric2",
        score: 0.9,
        threshold: 0.8,
      }), // Pass: greater
      createMockMetricStatistics({
        metric_name: "metric3",
        score: 0.7,
        threshold: 0.8,
      }), // Fail: less
    ];

    const result = calculateAcceptanceRate(metrics);

    expect(result).toEqual({
      acceptedCount: 2,
      totalCount: 3,
      rate: (2 / 3) * 100,
    });
  });

  test("counts only metrics meeting or exceeding threshold", () => {
    const metrics = [
      createMockMetricStatistics({ score: 0.95, threshold: 0.8 }), // Pass
      createMockMetricStatistics({ score: 0.85, threshold: 0.8 }), // Pass
      createMockMetricStatistics({ score: 0.8, threshold: 0.8 }), // Pass (boundary)
      createMockMetricStatistics({ score: 0.79, threshold: 0.8 }), // Fail (just below)
      createMockMetricStatistics({ score: 0.5, threshold: 0.8 }), // Fail
    ];

    const result = calculateAcceptanceRate(metrics);

    expect(result).toEqual({
      acceptedCount: 3,
      totalCount: 5,
      rate: 60,
    });
  });

  test("handles all metrics passing threshold", () => {
    const metrics = [
      createMockMetricStatistics({ score: 0.9, threshold: 0.8 }),
      createMockMetricStatistics({ score: 0.95, threshold: 0.8 }),
      createMockMetricStatistics({ score: 1.0, threshold: 0.8 }),
    ];

    const result = calculateAcceptanceRate(metrics);

    expect(result).toEqual({
      acceptedCount: 3,
      totalCount: 3,
      rate: 100,
    });
  });

  test("handles all metrics failing threshold", () => {
    const metrics = [
      createMockMetricStatistics({ score: 0.7, threshold: 0.8 }),
      createMockMetricStatistics({ score: 0.6, threshold: 0.8 }),
      createMockMetricStatistics({ score: 0.5, threshold: 0.8 }),
    ];

    const result = calculateAcceptanceRate(metrics);

    expect(result).toEqual({
      acceptedCount: 0,
      totalCount: 3,
      rate: 0,
    });
  });

  test("calculates rate as percentage of accepted/total", () => {
    const metrics = [
      createMockMetricStatistics({ score: 0.9, threshold: 0.8 }), // Pass
      createMockMetricStatistics({ score: 0.7, threshold: 0.8 }), // Fail
    ];

    const result = calculateAcceptanceRate(metrics);

    expect(result.acceptedCount).toBe(1);
    expect(result.totalCount).toBe(2);
    expect(result.rate).toBe(50);
  });

  test("handles boundary case: score exactly equal to threshold", () => {
    const metrics = [
      createMockMetricStatistics({ score: 0.75, threshold: 0.75 }),
      createMockMetricStatistics({ score: 0.749, threshold: 0.75 }),
      createMockMetricStatistics({ score: 0.751, threshold: 0.75 }),
    ];

    const result = calculateAcceptanceRate(metrics);

    // Only first and third should pass (0.75 >= 0.75 and 0.751 >= 0.75)
    expect(result).toEqual({
      acceptedCount: 2,
      totalCount: 3,
      rate: (2 / 3) * 100,
    });
  });
});

describe("sortMetricsByScore", () => {
  test("sorts metrics by score in ascending order", () => {
    const metrics = [
      createMockMetricStatistics({ metric_name: "high", score: 0.9 }),
      createMockMetricStatistics({ metric_name: "low", score: 0.5 }),
      createMockMetricStatistics({ metric_name: "medium", score: 0.7 }),
    ];

    const sorted = sortMetricsByScore(metrics);

    expect(sorted).toHaveLength(3);
    expect(sorted[0].metric_name).toBe("low");
    expect(sorted[0].score).toBe(0.5);
    expect(sorted[1].metric_name).toBe("medium");
    expect(sorted[1].score).toBe(0.7);
    expect(sorted[2].metric_name).toBe("high");
    expect(sorted[2].score).toBe(0.9);
  });

  test("sorts by score field in ascending order", () => {
    const metrics = [
      createMockMetricStatistics({ score: 1.0 }),
      createMockMetricStatistics({ score: 0.1 }),
      createMockMetricStatistics({ score: 0.5 }),
      createMockMetricStatistics({ score: 0.8 }),
    ];

    const sorted = sortMetricsByScore(metrics);

    expect(sorted.map((m) => m.score)).toEqual([0.1, 0.5, 0.8, 1.0]);
  });

  test("handles empty array", () => {
    const sorted = sortMetricsByScore([]);
    expect(sorted).toEqual([]);
  });

  test("handles single metric", () => {
    const metrics = [createMockMetricStatistics({ score: 0.75 })];
    const sorted = sortMetricsByScore(metrics);

    expect(sorted).toHaveLength(1);
    expect(sorted[0].score).toBe(0.75);
  });

  test("maintains stable sort for equal scores", () => {
    const metrics = [
      createMockMetricStatistics({ metric_name: "first", score: 0.8 }),
      createMockMetricStatistics({ metric_name: "second", score: 0.8 }),
      createMockMetricStatistics({ metric_name: "third", score: 0.8 }),
    ];

    const sorted = sortMetricsByScore(metrics);

    expect(sorted).toHaveLength(3);
    expect(sorted.every((m) => m.score === 0.8)).toBe(true);
  });

  test("does not mutate original array", () => {
    const metrics = [
      createMockMetricStatistics({ metric_name: "a", score: 0.9 }),
      createMockMetricStatistics({ metric_name: "b", score: 0.5 }),
      createMockMetricStatistics({ metric_name: "c", score: 0.7 }),
    ];

    const originalOrder = metrics.map((m) => m.metric_name);
    const sorted = sortMetricsByScore(metrics);

    // Original array should not be modified
    expect(metrics.map((m) => m.metric_name)).toEqual(originalOrder);

    // Sorted array should be different
    expect(sorted.map((m) => m.metric_name)).toEqual(["b", "c", "a"]);
  });

  test("sorts correctly with negative scores", () => {
    const metrics = [
      createMockMetricStatistics({ score: 0.5 }),
      createMockMetricStatistics({ score: -0.2 }),
      createMockMetricStatistics({ score: 0.0 }),
    ];

    const sorted = sortMetricsByScore(metrics);

    expect(sorted.map((m) => m.score)).toEqual([-0.2, 0.0, 0.5]);
  });

  test("places lowest scores first (worst to best)", () => {
    const metrics = [
      createMockMetricStatistics({ metric_name: "best", score: 1.0 }),
      createMockMetricStatistics({ metric_name: "worst", score: 0.1 }),
      createMockMetricStatistics({ metric_name: "okay", score: 0.6 }),
    ];

    const sorted = sortMetricsByScore(metrics);

    // Worst (lowest) should be first
    expect(sorted[0].metric_name).toBe("worst");
    expect(sorted.at(-1)?.metric_name).toBe("best");
  });
});
