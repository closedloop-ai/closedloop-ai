import type { TreeTruncation } from "@repo/api/src/types/project-tree";
import { formatNumber } from "../../shared/lib/format-utils";

/**
 * ISS-4576 — the wording of the My Tasks pagination footer, isolated as pure
 * functions so the *honesty* of each readout is unit-testable without rendering.
 *
 * The footer is the surface that can most easily lie. "Showing 1-50 of 500"
 * reads as a complete statement about the user's whole queue, so it may only be
 * rendered when the total behind it really is complete. Three cases exist and
 * each gets its own sentence rather than one sentence that quietly means
 * different things:
 *
 * 1. Complete total — the population is fully counted. State it plainly.
 * 2. Partial total — the counted population is a FLOOR because the underlying
 *    read was bounded (FEA-4373 caps the assigned-artifact fetch). The total is
 *    marked `+` and paired with a second line naming exactly how much was
 *    loaded, so the disclosure is specific instead of a vague "some results
 *    hidden". Both come from {@link resolveMyTasksTruncation} so the `+` can
 *    never appear orphaned without its explanation.
 * 3. Client-narrowed page — a search/facet predicate runs in the browser over
 *    ONE fetched page, or the board could not draw every row the server sent, so
 *    fewer rows reached the screen than the page holds. ISS-4682: the range line
 *    STAYS the anchor (replacing it cost the reader both the queue total and
 *    their place in it) and the caveat moves to a second line naming the page as
 *    its denominator — see {@link resolveMyTasksShownOnPageNote}. ISS-5280
 *    retired the flag that staged this, so it is now the only behaviour.
 */

/**
 * What a page of the My Tasks board counts.
 *
 * The All tab pages the ROOT of a nested tree, but "groups" is not a word this
 * screen uses anywhere else — and the same toolbar has a "Group by" control, so
 * "137 groups" would read as "137 status groups", which is false. "Top-level
 * tasks" says the same thing in the page's own vocabulary.
 */
export const MyTasksPagedUnit = {
  TopLevelTasks: "top-level tasks",
  Tasks: "tasks",
} as const;
export type MyTasksPagedUnit =
  (typeof MyTasksPagedUnit)[keyof typeof MyTasksPagedUnit];

type RangeReadoutInput = {
  /** 1-based index of the first visible row. */
  from: number;
  /** 1-based index of the last visible row. */
  to: number;
  total: number;
  unit: MyTasksPagedUnit;
  /**
   * True when `total` is a floor rather than the whole population — the counted
   * set was assembled from a bounded read that did not return everything.
   */
  isTotalPartial: boolean;
};

/**
 * "Showing 1-50 of 137 tasks" — the honest range readout for a page whose total
 * is known. When the total is a floor it is marked `+`, the convention readers
 * already parse correctly from Gmail and GitHub; the paired note from
 * {@link resolveMyTasksTruncation} carries the specifics.
 */
export function resolveMyTasksRangeReadout({
  from,
  to,
  total,
  unit,
  isTotalPartial,
}: RangeReadoutInput): string {
  const totalLabel = isTotalPartial
    ? `${formatNumber(total)}+`
    : formatNumber(total);
  return `Showing ${formatNumber(from)}-${formatNumber(to)} of ${totalLabel} ${unit}`;
}

type CardReadoutInput = {
  isNarrowed: boolean;
  /** How many cards the board actually mounts. */
  shownCount: number;
  /** Zero-based offset the SERVER reports applying to this page. */
  offset: number;
  /** How many rows the server returned for this page, before client narrowing. */
  pageCount: number;
  total: number;
};

/** A footer readout plus the optional caveat that belongs under it. */
export type MyTasksCardReadout = {
  /** The anchor sentence — always a range once a page has landed. */
  readout: string;
  /** The second line, or `null` when the range tells the whole story. */
  note: string | null;
};

/**
 * ISS-4682 item 3: the caveat for a page the board could not draw in full.
 *
 * Deliberately does NOT start with "Showing" — it sits directly beneath a line
 * that already does, and two stacked "Showing …" sentences read as one sentence
 * wrapping rather than as an anchor plus its caveat. It also does not assert WHY
 * the page narrowed: either cause (a browser-side predicate, or rows the board
 * cannot draw) would make the other reading wrong. Same shape as
 * {@link resolveMyTasksTruncation}'s polished note, so the two disclosures the
 * footer can show speak in one voice.
 */
export function resolveMyTasksShownOnPageNote(
  shownCount: number,
  pageCount: number
): string {
  return `Only ${formatNumber(shownCount)} of this page's ${formatNumber(pageCount)} tasks are shown.`;
}

/**
 * Pick the honest sentences for the card board's footer.
 *
 * A page can be narrower than what the server sent for two reasons — a
 * browser-side search/facet predicate, or rows the board cannot draw as cards
 * (non-navigable subtypes — see `selectKanbanArtifacts`) — and in both the
 * server's total has stopped describing the screen, so the footer must stop
 * claiming it describes the screen.
 *
 * ISS-4576 handled that by REPLACING the range with a page-scoped count. ISS-4682
 * (stage review) is that this trades one problem for another: a single
 * non-navigable row flips "Showing 1-50 of 137 tasks" to "Showing 49 of 50 tasks
 * on this page", so the reader loses BOTH the queue total and where they are in
 * it — while the 1 2 3 buttons still sit beside it, now anchored to nothing.
 *
 * So the range line stays the anchor and the caveat moves to the second line the
 * footer already accepts (`truncationNote`). The reader keeps their place, and
 * still learns the page is not fully drawn. ISS-5280 retired the flag that
 * staged this, so it is now the only behaviour.
 */
export function resolveMyTasksCardReadout({
  isNarrowed,
  shownCount,
  offset,
  pageCount,
  total,
}: CardReadoutInput): MyTasksCardReadout {
  const isPageNarrowed = isNarrowed || shownCount !== pageCount;
  // Anchor the range on the offset the SERVER reports applying, not on
  // `page * pageSize` — the client's arithmetic would describe a window it
  // never received whenever the server clamped the requested page.
  const readout = resolveMyTasksRangeReadout({
    from: pageCount === 0 ? 0 : offset + 1,
    isTotalPartial: false,
    to: offset + pageCount,
    total,
    unit: MyTasksPagedUnit.Tasks,
  });
  return {
    note: isPageNarrowed
      ? resolveMyTasksShownOnPageNote(shownCount, pageCount)
      : null,
    readout,
  };
}

/** Whether the count is a floor, and the note that says why. */
export type MyTasksTruncation = {
  /** Mark the total with `+`. */
  isTotalPartial: boolean;
  /** The disclosure line, or `null` when nothing was left out. */
  note: string | null;
};

/**
 * Resolve BOTH halves of the truncation disclosure from one predicate.
 *
 * The `+` marker and the explanatory note must never disagree: a bare "137+"
 * with nothing explaining it is a worse readout than no marker at all. Deriving
 * them together makes an orphaned marker unrepresentable.
 *
 * `loaded` is how many rows the bounded read returned; `assignedTotal` is the
 * server's real count.
 *
 * ISS-4682 item 5: the ISS-4576 note stacked a THIRD and FOURTH number under the
 * range line — "Showing 1-50 of 550+ top-level tasks" over "Only the first 500
 * of 620 are loaded." puts 550+, 500 and 620 in one glance with nothing saying
 * which one is the queue. It also ended in "are loaded", a fetch word with no
 * noun attached. The note states ONE number, the bound the reader is actually
 * behind. ISS-5280 retired the flag that staged this, so it is now the only
 * wording.
 *
 * ISS-5280 (review) fixed two things that replacement got wrong:
 *
 * 1. It said the first `loaded` tasks "are shown", while the screen is showing
 *    ONE page of 50. "Shown" was the one word on the line a reader could check
 *    against the screen, and it was the word that was false — and the card
 *    footer's sibling note ("Only 49 of this page's 50 tasks are shown.") uses
 *    "shown" correctly, so the same footer slot had two meanings for it.
 *    "Counted from" names what the bound actually is: the population the total
 *    above was counted out of.
 * 2. It reused the anchor line's noun. Under "Showing 1-50 of 550+ top-level
 *    tasks", a bare "…500 tasks…" reads as directly comparable, and the two are
 *    NOT counting the same thing — `loaded` counts raw assigned artifacts while
 *    the total counts the roots they fold into. Threading the page's own unit
 *    through would make that worse by making the nouns identical; naming the
 *    other population ("assigned tasks") is what actually says they differ.
 */
export function resolveMyTasksTruncation(
  loaded: number,
  assignedTotal: number
): MyTasksTruncation {
  if (loaded >= assignedTotal) {
    return { isTotalPartial: false, note: null };
  }
  return {
    isTotalPartial: true,
    note: `Counted from the first ${formatNumber(loaded)} assigned tasks.`,
  };
}

/**
 * The TREE stream's own floor marker (FEA-1651).
 *
 * `GET /artifacts/assigned-tree` bounds its walk and reports `truncation` when
 * a bound bound. The footer's "of N" is built to reconcile with every visible
 * root across every stream, so a bounded tree read makes that number a FLOOR —
 * and the footer has to say so, or a whole stream leaves the count with nothing
 * on screen saying the number changed meaning.
 *
 * `anchorsIncluded` is the exact count the server walked, not the
 * `anchorsMatchedAtLeast` floor, because the note states what the reader IS
 * seeing rather than an inexact guess at what they are missing.
 */
export function resolveMyTasksTreeTruncation(
  truncation: TreeTruncation | undefined
): MyTasksTruncation {
  if (!truncation) {
    return { isTotalPartial: false, note: null };
  }
  return {
    isTotalPartial: true,
    note: `Only your first ${formatNumber(truncation.anchorsIncluded)} tasks were expanded into the tree.`,
  };
}

/**
 * Fold every stream's floor marker into the ONE the footer renders.
 *
 * Each stream can be bounded independently, but the footer states a single
 * total, so a `+` on that total means "at least one stream was bounded" and
 * every reason has to be named — dropping one would leave a marker whose
 * explanation is incomplete, which is the orphaned-marker failure
 * {@link resolveMyTasksTruncation} exists to prevent.
 */
export function mergeMyTasksTruncations(
  truncations: MyTasksTruncation[]
): MyTasksTruncation {
  const notes: string[] = [];
  for (const truncation of truncations) {
    if (truncation.isTotalPartial && truncation.note !== null) {
      notes.push(truncation.note);
    }
  }
  if (notes.length === 0) {
    return { isTotalPartial: false, note: null };
  }
  return { isTotalPartial: true, note: notes.join(" ") };
}
