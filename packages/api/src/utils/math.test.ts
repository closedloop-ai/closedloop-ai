import { describe, expect, it } from "vitest";
import { median } from "./math";

describe("median", () => {
  it("returns null for an empty array", () => {
    expect(median([])).toBeNull();
  });

  it("returns the single value for a one-element array", () => {
    expect(median([7])).toBe(7);
  });

  it("returns the middle value for odd-length input", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the two middle values for even-length input", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("sorts numerically, not lexicographically", () => {
    expect(median([10, 2, 33, 4])).toBe(7);
  });

  it("handles duplicates and negatives", () => {
    expect(median([-5, -5, 0, 5])).toBe(-2.5);
  });

  it("does not mutate the input array", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});
