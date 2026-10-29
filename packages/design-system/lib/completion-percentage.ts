/**
 * The one rule that turns a completion percentage into what a surface may
 * claim, in a module with NO component imports so copy modules can share it.
 *
 * `100%` is a terminal claim, not a rounding outcome: it asserts the population
 * is exhausted. Rounding reaches it from values that assert nothing of the sort
 * — 199 of 200 documents is 99.5%, which `Math.round` promotes to a filled
 * check and the sentence "100% of documents and issues complete", with nothing
 * left on the row to contradict it (ISS-9922).
 *
 * ONLY 100 IS RESERVED, AND THE MID-RANGE IS UNTOUCHED (operator ruling
 * 2026-09-18, on the tamsinb and marisolashgrove reviews of #7530). An earlier
 * cut floored the whole range, which moved the rendered number on roughly half
 * of every partial row — 2/3 went from 67 to 66 — and added a `Math.max(1, …)`
 * so a sub-1% project read "1% complete". Neither was asked for by the ticket,
 * and the second is the same class of overstatement pointed the other way: 1 of
 * 1000 is 0.1%, and claiming 1% of it is done is a claim nobody measured. The
 * rule is now `Math.min(99, Math.round(…))`: round everywhere, and cap so the
 * terminal claim stays unreachable from below.
 *
 * Returning the predicate beside the number is the load-bearing part: the
 * mark and the accessible name are two channels over one value, and deriving
 * them from two rules is what let an incomplete ring announce "100% complete"
 * to a screen reader.
 *
 * The reserve holds over the [0, 100] domain the callers actually produce. A
 * value ABOVE 100 still resolves to complete, deliberately: "more than all of
 * it" is not a partial state, and the alternative — 100 in the sentence beside
 * a ring the mark says is unfinished — recreates the exact contradiction this
 * module exists to make unexpressible.
 *
 * A NON-FINITE VALUE IS REFUSED RATHER THAN PASSED THROUGH (whitlockk review). The
 * previous text said it passed through as itself, and that was both wrong and
 * the more damaging of the two: `NaN` survived the clamp, so the label rendered
 * "NaN% complete" and the arc got `NaN` dash offsets, while `Infinity` clamped
 * to 100 and earned the filled check — the terminal claim, handed to a value
 * that is not a measurement at all. Both now resolve to `{ 0, not complete }`.
 * That zero is a REFUSAL, not the measured zero the callers produce: no claim
 * is safe over garbage, and of the two unsafe ones an unstarted ring is the
 * one a reader can recover from. A non-finite value reaching here is an upstream
 * defect and this is a render boundary, not its diagnosis.
 */

export type CompletionDisplay = {
  /** A finite input clamped to `[0, 100]`, for continuous geometry like an arc. */
  clamped: number;
  /** The single predicate every completeness channel must answer to. */
  isComplete: boolean;
  /**
   * Integer to render. Over a finite input it reads `100` exactly when
   * `isComplete` and `0` exactly when nothing has started.
   */
  percentage: number;
};

export function resolveCompletionDisplay(value: number): CompletionDisplay {
  // FIRST, before the clamp, because the clamp is what hides both failures:
  // `Math.min(100, Infinity)` is 100, which would earn the complete check, and
  // `NaN` survives every comparison below to reach the DOM as `NaN`.
  if (!Number.isFinite(value)) {
    return { clamped: 0, isComplete: false, percentage: 0 };
  }

  const clamped = Math.max(0, Math.min(100, value));

  if (clamped >= 100) {
    return { clamped, isComplete: true, percentage: 100 };
  }
  if (clamped <= 0) {
    return { clamped, isComplete: false, percentage: 0 };
  }
  // Round, then cap: `Math.round` alone promotes 99.5 to the reserved 100, and
  // the cap is the whole reserve. There is no lower guard — a started-but-tiny
  // fraction reads 0%, per the 2026-09-18 ruling, because inventing a 1% for it
  // is the same unmeasured claim in the other direction. The API applies the
  // same rule to the counts in `apps/api/app/projects/service.ts`, where the
  // numerator and denominator that this module never sees still exist.
  return {
    clamped,
    isComplete: false,
    percentage: Math.min(99, Math.round(clamped)),
  };
}
