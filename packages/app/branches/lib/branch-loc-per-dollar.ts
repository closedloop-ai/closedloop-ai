/**
 * LOC/$ (lines changed ÷ estimated cost) empty-state copy and reason
 * resolver, extracted from `branch-derivations.ts` (FEA-4229/4236) to keep that
 * near-ceiling module from growing. Pure, surface-agnostic: no electron /
 * window / DB / `apps/*` imports, so it runs identically in the desktop
 * main-process projector and any renderer composition.
 *
 * The reason strings and the predicate live together so the LOC/$ card and
 * any sibling breakdown can't drift apart the way the card and the lead-time
 * breakdown did before (FEA-4229). Kept beside the lead-time copy in the same
 * product voice: a merged branch with no diff stats is a sync gap, stated as a
 * sentence rather than our internal "not synced" jargon.
 */

/**
 * LOC/$ empty copy for the merged case: the branch merged but its diff
 * stats haven't synced, so lines changed are unknown.
 */
export const LOC_MERGED_UNAVAILABLE_MESSAGE =
  "This branch merged, but its lines changed haven't synced yet.";

/** LOC/$ empty copy for the non-merged case (no diff stats to show yet). */
export const LOC_UNAVAILABLE_MESSAGE = "Lines changed unavailable.";

/**
 * LOC/$ empty copy when lines changed ARE known but the estimated cost is
 * not (missing OR zero — a zero denominator can't yield a ratio either), so the
 * ratio can't be computed. Kept distinct from the lines-changed copy (FEA-4236)
 * so the caption never claims "lines changed haven't synced" for a branch whose
 * lines changed we actually have — the missing input is cost. Trimmed to the bare
 * cause (the card already says "No data" under a "LOC / $" label, so the
 * second clause was redundant) to sit closer to the sibling `Lines changed
 * unavailable.` copy.
 */
export const LOC_PER_DOLLAR_COST_UNAVAILABLE_MESSAGE =
  "Estimated cost is unavailable.";

/**
 * Whether the estimated cost can serve as a LOC/$ denominator. Mirrors
 * `locPerDollar`'s own guard (`totalCostUsd == null || totalCostUsd === 0`): a
 * priced-zero branch ($0.00) has no usable denominator, so it reads as an
 * unavailable cost — not a real cost the caption should print beside "No data"
 * (FEA-4236, zero-cost handling).
 */
export function isLocPerDollarCostUnavailable(
  totalCostUsd: number | null
): boolean {
  return totalCostUsd == null || totalCostUsd === 0;
}

/**
 * The reason the LOC/$ card has no value, or `null` when it does. SSOT for
 * the empty-state caption so the web app and desktop renderer never drift
 * (FEA-4229/4236). Takes the raw `totalCostUsd` (not a pre-computed boolean) so
 * the zero-cost denominator decision lives HERE, next to the reason it produces,
 * and a caller can't classify $0.00 wrong. Lines-changed missing is the
 * dominant, VQA-reported case and wins when both inputs are absent; when only
 * the cost is missing or zero, the caption names THAT gap rather than falsely
 * claiming lines changed haven't synced.
 */
export function resolveLocPerDollarUnavailableReason(args: {
  churn: number | null;
  totalCostUsd: number | null;
  merged: boolean;
}): string | null {
  if (args.churn == null) {
    return args.merged
      ? LOC_MERGED_UNAVAILABLE_MESSAGE
      : LOC_UNAVAILABLE_MESSAGE;
  }
  if (isLocPerDollarCostUnavailable(args.totalCostUsd)) {
    return LOC_PER_DOLLAR_COST_UNAVAILABLE_MESSAGE;
  }
  return null;
}
