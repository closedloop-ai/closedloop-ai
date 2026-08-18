import { BranchNoComparisonReason } from "./branch-no-comparison-reason";

// Copy constants for the branch-detail headline cards (D6). Kept in a lightweight
// module so the reason string is an importable SSOT — tests and the component
// read the same literal instead of re-declaring it.

/**
 * Tooltip + screen-reader reason for the "No comparison" delta-slot chip on the
 * branch-detail headline cards. The shared `KpiDeltaPlaceholder` default reason
 * (`NO_COMPARISON_LABEL`) states only that no comparison is available for the
 * range, which is true here but says nothing a reader can act on. On branch
 * detail there is no range control and no 30-day baseline is computed for this
 * surface yet, so this names the real cause (FEA-4241 review) without implying
 * the branch is too young or too quiet.
 *
 * It names the CARD, not "branch detail" — that is our word for the screen, not
 * the reader's (#4242 review). It is also the sentence every reason that comes
 * down to "we have no comparison we can stand behind" reuses, so the reader
 * never gets a tooltip about our own bookkeeping.
 */
export const BRANCH_NO_BASELINE_REASON =
  "A 30-day comparison isn't available for this card yet.";

/**
 * Tooltip + screen-reader sentence for EVERY reason a branch-detail card has no
 * comparison to show (ISS-4686). Exhaustive over `BranchNoComparisonReason`, so
 * a new reason cannot ship without copy that explains it.
 *
 * Every sentence has to read as "we can't compare this", never as "nothing
 * changed" — a card that implies a flat period when it simply has no comparable
 * baseline is the same class of lie as the mismatched verdict this guard exists
 * to prevent. None restates the conclusion: the chip beside it already says "No
 * comparison", and a screen reader reads that label immediately before this
 * sentence, so a trailing "…so we can't compare" would say it twice.
 *
 * `null` means "render no chip at all": the value slot already says "No data",
 * so a "No comparison" chip beside it would answer a question the card never
 * raised. (On LOC / $ the caption also names the cause; the lead-time card's
 * caption does not, and the breakdown section directly beneath it carries that
 * explanation instead — see `branch-headline-cards.tsx`.)
 */
export const BRANCH_NO_COMPARISON_REASON: Record<
  BranchNoComparisonReason,
  string | null
> = {
  [BranchNoComparisonReason.NotComputed]: BRANCH_NO_BASELINE_REASON,
  // UnknownScope and ValueMismatch are OUR bookkeeping — an unlabelled scope and
  // a baseline that tracks some other number are both problems the reader cannot
  // act on, and spelling them out reads as us admitting our data is confused
  // (#4242 review). The reader's takeaway is identical to NotComputed's, so they
  // reuse that sentence and the detail stays in the reason-code docs above.
  [BranchNoComparisonReason.UnknownScope]: BRANCH_NO_BASELINE_REASON,
  // ScopeMismatch is SYMMETRIC — the reason code carries no direction, and the
  // resolver raises it whenever the two populations differ either way. Naming a
  // population ("covers all branches, not this one") would be a confident claim
  // the code cannot back the moment a corpus-scoped card meets a branch-scoped
  // baseline, which is the exact class of wrong verdict this guard exists to
  // stop (#4242 review).
  [BranchNoComparisonReason.ScopeMismatch]:
    "The 30-day comparison covers a different set of branches than this card.",
  [BranchNoComparisonReason.BasisMismatch]:
    "The 30-day comparison isn't measured the same way as the number on this card.",
  [BranchNoComparisonReason.ValueMismatch]: BRANCH_NO_BASELINE_REASON,
  [BranchNoComparisonReason.ValueUnavailable]: null,
};
