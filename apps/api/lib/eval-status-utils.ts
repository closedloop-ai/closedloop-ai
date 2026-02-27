import { EvalStatus } from "@repo/api/src/types/evaluation";

/**
 * Convert a Prisma JudgeScore.finalStatus (Int) to the API EvalStatus type.
 * Valid values: 1 (Failed), 2 (NeedsImprovement), 3 (Passed).
 * Throws on unexpected values to surface data corruption.
 */
export function toEvalStatus(n: number): EvalStatus {
  switch (n) {
    case EvalStatus.Failed:
      return EvalStatus.Failed;
    case EvalStatus.NeedsImprovement:
      return EvalStatus.NeedsImprovement;
    case EvalStatus.Passed:
      return EvalStatus.Passed;
    default:
      throw new Error(
        `Invalid EvalStatus: expected 1|2|3 (Failed|NeedsImprovement|Passed), got ${n}`
      );
  }
}
