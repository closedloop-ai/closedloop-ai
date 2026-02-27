import { EvalStatus } from "@repo/api/src/types/evaluation";
import { toEvalStatus } from "@/lib/eval-status-utils";

describe("toEvalStatus", () => {
  it("returns EvalStatus.Failed for FAILED", () => {
    expect(toEvalStatus("FAILED")).toBe(EvalStatus.Failed);
  });

  it("returns EvalStatus.NeedsImprovement for NEEDS_IMPROVEMENT", () => {
    expect(toEvalStatus("NEEDS_IMPROVEMENT")).toBe(EvalStatus.NeedsImprovement);
  });

  it("returns EvalStatus.Passed for PASSED", () => {
    expect(toEvalStatus("PASSED")).toBe(EvalStatus.Passed);
  });

  it("throws for invalid values", () => {
    expect(() => toEvalStatus("FAILED_")).toThrow("Invalid EvalStatus");
    expect(() => toEvalStatus("PASS")).toThrow("Invalid EvalStatus");
    expect(() => toEvalStatus("")).toThrow("Invalid EvalStatus");
    expect(() => toEvalStatus("unknown")).toThrow("Invalid EvalStatus");
  });
});
