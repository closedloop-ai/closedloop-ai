import { describe, expect, test } from "vitest";
import { createMockJudgeFeedbackItem } from "@/__tests__/fixtures/evaluation";
import {
  calculateAcceptanceRate,
  sortMetricsByScore,
} from "../evaluation-utils";

describe("calculateAcceptanceRate", () => {
  test("returns zero rate for undefined items", () => {
    const result = calculateAcceptanceRate(undefined);
    expect(result).toEqual({
      acceptedCount: 0,
      totalCount: 0,
      rate: 0,
    });
  });

  test("returns zero rate for empty items array", () => {
    const result = calculateAcceptanceRate([]);
    expect(result).toEqual({
      acceptedCount: 0,
      totalCount: 0,
      rate: 0,
    });
  });

  test("uses score >= threshold logic for acceptance", () => {
    const items = [
      createMockJudgeFeedbackItem({
        caseId: "item1",
        score: 0.8,
        threshold: 0.8,
      }), // Pass: equal
      createMockJudgeFeedbackItem({
        caseId: "item2",
        score: 0.9,
        threshold: 0.8,
      }), // Pass: greater
      createMockJudgeFeedbackItem({
        caseId: "item3",
        score: 0.7,
        threshold: 0.8,
      }), // Fail: less
    ];

    const result = calculateAcceptanceRate(items);

    expect(result).toEqual({
      acceptedCount: 2,
      totalCount: 3,
      rate: (2 / 3) * 100,
    });
  });

  test("counts only items meeting or exceeding threshold", () => {
    const items = [
      createMockJudgeFeedbackItem({ score: 0.95, threshold: 0.8 }), // Pass
      createMockJudgeFeedbackItem({ score: 0.85, threshold: 0.8 }), // Pass
      createMockJudgeFeedbackItem({ score: 0.8, threshold: 0.8 }), // Pass (boundary)
      createMockJudgeFeedbackItem({ score: 0.79, threshold: 0.8 }), // Fail (just below)
      createMockJudgeFeedbackItem({ score: 0.5, threshold: 0.8 }), // Fail
    ];

    const result = calculateAcceptanceRate(items);

    expect(result).toEqual({
      acceptedCount: 3,
      totalCount: 5,
      rate: 60,
    });
  });

  test("handles all items passing threshold", () => {
    const items = [
      createMockJudgeFeedbackItem({ score: 0.9, threshold: 0.8 }),
      createMockJudgeFeedbackItem({ score: 0.95, threshold: 0.8 }),
      createMockJudgeFeedbackItem({ score: 1.0, threshold: 0.8 }),
    ];

    const result = calculateAcceptanceRate(items);

    expect(result).toEqual({
      acceptedCount: 3,
      totalCount: 3,
      rate: 100,
    });
  });

  test("handles all items failing threshold", () => {
    const items = [
      createMockJudgeFeedbackItem({ score: 0.7, threshold: 0.8 }),
      createMockJudgeFeedbackItem({ score: 0.6, threshold: 0.8 }),
      createMockJudgeFeedbackItem({ score: 0.5, threshold: 0.8 }),
    ];

    const result = calculateAcceptanceRate(items);

    expect(result).toEqual({
      acceptedCount: 0,
      totalCount: 3,
      rate: 0,
    });
  });

  test("calculates rate as percentage of accepted/total", () => {
    const items = [
      createMockJudgeFeedbackItem({ score: 0.9, threshold: 0.8 }), // Pass
      createMockJudgeFeedbackItem({ score: 0.7, threshold: 0.8 }), // Fail
    ];

    const result = calculateAcceptanceRate(items);

    expect(result.acceptedCount).toBe(1);
    expect(result.totalCount).toBe(2);
    expect(result.rate).toBe(50);
  });

  test("handles boundary case: score exactly equal to threshold", () => {
    const items = [
      createMockJudgeFeedbackItem({ score: 0.75, threshold: 0.75 }),
      createMockJudgeFeedbackItem({ score: 0.749, threshold: 0.75 }),
      createMockJudgeFeedbackItem({ score: 0.751, threshold: 0.75 }),
    ];

    const result = calculateAcceptanceRate(items);

    // Only first and third should pass (0.75 >= 0.75 and 0.751 >= 0.75)
    expect(result).toEqual({
      acceptedCount: 2,
      totalCount: 3,
      rate: (2 / 3) * 100,
    });
  });
});

describe("sortMetricsByScore", () => {
  test("sorts items by score in ascending order", () => {
    const items = [
      createMockJudgeFeedbackItem({ caseId: "high", score: 0.9 }),
      createMockJudgeFeedbackItem({ caseId: "low", score: 0.5 }),
      createMockJudgeFeedbackItem({ caseId: "medium", score: 0.7 }),
    ];

    const sorted = sortMetricsByScore(items);

    expect(sorted).toHaveLength(3);
    expect(sorted[0].caseId).toBe("low");
    expect(sorted[0].score).toBe(0.5);
    expect(sorted[1].caseId).toBe("medium");
    expect(sorted[1].score).toBe(0.7);
    expect(sorted[2].caseId).toBe("high");
    expect(sorted[2].score).toBe(0.9);
  });

  test("sorts by score field in ascending order", () => {
    const items = [
      createMockJudgeFeedbackItem({ score: 1.0 }),
      createMockJudgeFeedbackItem({ score: 0.1 }),
      createMockJudgeFeedbackItem({ score: 0.5 }),
      createMockJudgeFeedbackItem({ score: 0.8 }),
    ];

    const sorted = sortMetricsByScore(items);

    expect(sorted.map((m) => m.score)).toEqual([0.1, 0.5, 0.8, 1.0]);
  });

  test("handles empty array", () => {
    const sorted = sortMetricsByScore([]);
    expect(sorted).toEqual([]);
  });

  test("handles single item", () => {
    const items = [createMockJudgeFeedbackItem({ score: 0.75 })];
    const sorted = sortMetricsByScore(items);

    expect(sorted).toHaveLength(1);
    expect(sorted[0].score).toBe(0.75);
  });

  test("maintains stable sort for equal scores", () => {
    const items = [
      createMockJudgeFeedbackItem({ caseId: "first", score: 0.8 }),
      createMockJudgeFeedbackItem({ caseId: "second", score: 0.8 }),
      createMockJudgeFeedbackItem({ caseId: "third", score: 0.8 }),
    ];

    const sorted = sortMetricsByScore(items);

    expect(sorted).toHaveLength(3);
    expect(sorted.every((m) => m.score === 0.8)).toBe(true);
  });

  test("does not mutate original array", () => {
    const items = [
      createMockJudgeFeedbackItem({ caseId: "a", score: 0.9 }),
      createMockJudgeFeedbackItem({ caseId: "b", score: 0.5 }),
      createMockJudgeFeedbackItem({ caseId: "c", score: 0.7 }),
    ];

    const originalOrder = items.map((m) => m.caseId);
    const sorted = sortMetricsByScore(items);

    // Original array should not be modified
    expect(items.map((m) => m.caseId)).toEqual(originalOrder);

    // Sorted array should be different
    expect(sorted.map((m) => m.caseId)).toEqual(["b", "c", "a"]);
  });

  test("sorts correctly with negative scores", () => {
    const items = [
      createMockJudgeFeedbackItem({ score: 0.5 }),
      createMockJudgeFeedbackItem({ score: -0.2 }),
      createMockJudgeFeedbackItem({ score: 0.0 }),
    ];

    const sorted = sortMetricsByScore(items);

    expect(sorted.map((m) => m.score)).toEqual([-0.2, 0.0, 0.5]);
  });

  test("places lowest scores first (worst to best)", () => {
    const items = [
      createMockJudgeFeedbackItem({ caseId: "best", score: 1.0 }),
      createMockJudgeFeedbackItem({ caseId: "worst", score: 0.1 }),
      createMockJudgeFeedbackItem({ caseId: "okay", score: 0.6 }),
    ];

    const sorted = sortMetricsByScore(items);

    // Worst (lowest) should be first
    expect(sorted[0].caseId).toBe("worst");
    expect(sorted.at(-1)?.caseId).toBe("best");
  });
});
