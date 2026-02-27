import { EvalStatus } from "@repo/api/src/types/evaluation";
import { toEvalStatus } from "@/lib/eval-status-utils";

describe("toEvalStatus", () => {
  it("returns EvalStatus.Failed for 1", () => {
    expect(toEvalStatus(1)).toBe(EvalStatus.Failed);
  });

  it("returns EvalStatus.NeedsImprovement for 2", () => {
    expect(toEvalStatus(2)).toBe(EvalStatus.NeedsImprovement);
  });

  it("returns EvalStatus.Passed for 3", () => {
    expect(toEvalStatus(3)).toBe(EvalStatus.Passed);
  });

  it("throws for invalid values", () => {
    expect(() => toEvalStatus(0)).toThrow("Invalid EvalStatus");
    expect(() => toEvalStatus(4)).toThrow("Invalid EvalStatus");
    expect(() => toEvalStatus(-1)).toThrow("Invalid EvalStatus");
    expect(() => toEvalStatus(Number.NaN)).toThrow("Invalid EvalStatus");
  });
});
