import { describe, expect, it } from "vitest";
import { branchPageRange } from "./branch-list-state";

describe("branchPageRange", () => {
  it.each([
    [0, 47, "1–20 of 47"],
    [1, 47, "21–40 of 47"],
    [2, 47, "41–47 of 47"],
    [0, 0, "0 of 0"],
  ])("announces page %s of %s", (page, total, expected) => {
    expect(branchPageRange(page, total)).toBe(expected);
  });
});
