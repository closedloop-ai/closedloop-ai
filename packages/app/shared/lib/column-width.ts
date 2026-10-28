/**
 * The ONE definition of a usable persisted column width, read by every boundary
 * that decides whether a stored width is a width.
 *
 * ISS-9447 (review): there were two predicates with two different answers. The
 * parse boundary (`view-state-axes.ts`) accepted any finite positive number,
 * the apply/carry boundary (`preserved-column-ids.ts`) refused anything past a
 * 10_000px ceiling — so a stored 10001 survived into a NAMED view's arrangement
 * and was filtered out of the live one, and `branchArrangementsEqual` then read
 * the view as "Modified" the instant it was opened, with nothing the reader
 * could do to reconcile it. One predicate and one ceiling, imported by both, is
 * what makes that disagreement unrepresentable rather than merely fixed.
 *
 * Its own module rather than an export from `view-state-axes.ts` because that
 * module imports Zod and `preserved-column-ids.ts` is reached from the render
 * path of every persisted table — the repo's split-constants-from-parsers rule.
 */

/**
 * The ceiling a stored width has to fall under to be treated as a width (px).
 *
 * `Number.MAX_VALUE` is finite and positive, so a floor alone stores it and the
 * column it names later becomes an enormous CSS track. 10_000px is past the
 * width of any display the table is drawn on — an 8K panel is 7680px wide — so
 * no resize a reader can perform reaches it, while a magnitude that could only
 * come from corruption is refused. Deliberately not `Number.MAX_SAFE_INTEGER`,
 * which is not a plausible column width and only moves the problem.
 *
 * Fractional widths stay usable on purpose: a sub-pixel width is what a real
 * drag on a fractional-DPR display produces.
 */
export const MAX_USABLE_COLUMN_WIDTH_PX = 10_000;

/** Whether `width` is a width this build will store, carry, or apply. */
export function isUsableColumnWidth(width: number): boolean {
  return (
    Number.isFinite(width) && width > 0 && width <= MAX_USABLE_COLUMN_WIDTH_PX
  );
}

/**
 * The approved default width of the leading Artifact/Name identity column (px).
 *
 * ISS-9095 column contract item 2 — "the Artifact/Name column uses the approved
 * wider default inherited everywhere" — which two surfaces were satisfying by
 * each spelling `280` as a bare literal of its own. One is the demo grid, one is
 * the portable artifact shell; a change to the approved width had to be made
 * twice and nothing failed when it was made once.
 *
 * It lives beside the width predicates rather than in a fixture module because
 * both readers are production-bound composition and neither owns the other's
 * fixtures. It is a DEFAULT, not a bound: the column is resizable and a reader's
 * own width supersedes it.
 */
export const ARTIFACT_IDENTITY_COLUMN_WIDTH_PX = 280;
