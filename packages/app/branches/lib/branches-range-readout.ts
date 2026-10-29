/**
 * ISS-9225 — the Branches list's pagination SENTENCE, and nothing else.
 *
 * The wording is the terse range this list shipped, kept deliberately different
 * from Sessions' announced sentence: `ListSurfacePaginationFooter` unified the
 * footer's implementation, and unifying an implementation does not license
 * rewording a control (the boundary visual QA held during PR #6680).
 *
 * The range itself, and the states in which there is none, are `listPageRange`'s
 * — shared with Sessions since ISS-9216 and derived once, in the footer.
 */
import type { ListPageRange } from "../../shared/lib/list-pagination-readout";

/**
 * "1–25 of 240", or `null` on a list with no rows on this page: the empty state
 * above already says there is nothing, so a `0–0 of 0` under it would restate a
 * non-fact. This is Branches' shipped `total > 0` behaviour, expressed over the
 * range rather than beside it.
 */
export function branchesRangeReadout(
  { from, to }: ListPageRange,
  total: number
): string | null {
  if (to === 0) {
    return null;
  }
  return `${from}–${to} of ${total}`;
}
