import { describe, expect, it } from "vitest";
import { isStaleExpectation } from "./optimistic-write-guard";

// ISS-9486 review (marisolashgrove, PR #7926): a direct, colocated truth table
// for the guard now shared by two independently-deployed surfaces —
// absent / null / same-value / different — plus the `requested === undefined`
// arm Desktop can never reach (its write request requires `priority`), which
// was otherwise pinned only incidentally by whichever apps/api service test
// happened to omit a field's new value.
describe("isStaleExpectation", () => {
  it("an absent expectation is unguarded last-write-wins", () => {
    expect(isStaleExpectation("a", "b", undefined)).toBe(false);
  });

  it("a null expectation matching a null current is not stale", () => {
    expect(isStaleExpectation(null, "b", null)).toBe(false);
  });

  it("a same-value retry is not stale even against a mismatched expectation", () => {
    expect(isStaleExpectation("b", "b", "a")).toBe(false);
  });

  it("a mismatched expectation is stale when this write does not set the field", () => {
    expect(isStaleExpectation("a", undefined, "b")).toBe(true);
  });

  it("a mismatched expectation is stale when the request differs from current too", () => {
    expect(isStaleExpectation("a", "c", "b")).toBe(true);
  });
});
