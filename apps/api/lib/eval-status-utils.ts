import { EvalStatus } from "@repo/api/src/types/evaluation";

/**
 * Validate/normalize a persisted JudgeScore.finalStatus to API EvalStatus.
 * Valid values: FAILED, NEEDS_IMPROVEMENT, PASSED.
 * Throws on unexpected values to surface data corruption.
 */
export function toEvalStatus(status: string): EvalStatus {
  switch (status) {
    case EvalStatus.Failed:
      return EvalStatus.Failed;
    case EvalStatus.NeedsImprovement:
      return EvalStatus.NeedsImprovement;
    case EvalStatus.Passed:
      return EvalStatus.Passed;
    default:
      throw new Error(
        `Invalid EvalStatus: expected FAILED|NEEDS_IMPROVEMENT|PASSED, got ${status}`
      );
  }
}
