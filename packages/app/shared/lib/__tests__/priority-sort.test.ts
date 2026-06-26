import { Priority } from "@repo/api/src/types/common";
import { describe, expect, it } from "vitest";
import { comparePriorityValues } from "../priority-sort";

describe("comparePriorityValues", () => {
  it("returns 0 when both priorities are absent", () => {
    expect(comparePriorityValues(null, null)).toBe(0);
    expect(comparePriorityValues(undefined, undefined)).toBe(0);
    expect(comparePriorityValues(null, undefined)).toBe(0);
  });

  it("sorts an absent priority after a present one", () => {
    expect(comparePriorityValues(null, Priority.Low)).toBe(1);
    expect(comparePriorityValues(undefined, Priority.Urgent)).toBe(1);
  });

  it("sorts a present priority before an absent one", () => {
    expect(comparePriorityValues(Priority.Low, null)).toBe(-1);
    expect(comparePriorityValues(Priority.Urgent, undefined)).toBe(-1);
  });

  it("orders Urgent < High < Medium < Low (negative means a sorts first)", () => {
    expect(comparePriorityValues(Priority.Urgent, Priority.Low)).toBeLessThan(
      0
    );
    expect(
      comparePriorityValues(Priority.Low, Priority.Urgent)
    ).toBeGreaterThan(0);
    expect(comparePriorityValues(Priority.High, Priority.Medium)).toBeLessThan(
      0
    );
  });

  it("returns 0 for equal priorities", () => {
    expect(comparePriorityValues(Priority.Medium, Priority.Medium)).toBe(0);
  });

  it("sorts a list highest-priority-first with absent values last", () => {
    const sorted = [
      Priority.Low,
      null,
      Priority.Urgent,
      Priority.Medium,
      undefined,
      Priority.High,
    ].sort(comparePriorityValues);

    expect(sorted).toEqual([
      Priority.Urgent,
      Priority.High,
      Priority.Medium,
      Priority.Low,
      null,
      undefined,
    ]);
  });
});
