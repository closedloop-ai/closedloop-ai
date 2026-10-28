import type { BranchAssociatedPullRequestCollection } from "@repo/api/src/types/branch-associated-pull-request";
import { BranchAssociatedPullRequestCompletenessState } from "@repo/api/src/types/branch-associated-pull-request";

// Copy constants for the Branch detail outcome presentation
// (ISS-6954 / ISS-6955 / ISS-6957). Kept in a lightweight module so each string
// is an importable SSOT — the components and their tests read the same literal
// instead of re-declaring it.

/**
 * ISS-6954: the outcome metric's name, stated ONCE, by the headline card.
 *
 * The screen used to name the same measurement twice — a headline card and a
 * section heading below it, in two treatments and two wordings, with nothing
 * telling a reader they were one metric. The card is the survivor (it carries
 * the number, the definition tooltip and the not-applicable arm); the waterfall
 * beneath it is that number's breakdown and no longer names a metric at all.
 *
 * "Cycle Time" over the shipped "Lead time for change" is the ticket's own
 * decision, quoted verbatim, not a wording call made here.
 */
export const BRANCH_CYCLE_TIME_LABEL = "Cycle Time";

/**
 * ISS-6954 / ISS-6955: the waterfall's heading once it stops naming a metric.
 *
 * It is FIXED rather than derived, and that is what closes both tickets at once.
 * Derived, it restated whichever metric the card above had just named (6954);
 * and with no outcome track to derive from it fell back to the merged-outcome
 * label on branches that never merged, so the page contradicted itself and the
 * wrong version was the one in larger type (6955). A heading that names the
 * section's JOB instead of a measurement cannot do either.
 *
 * Built from vocabulary already on this screen rather than invented: the sibling
 * section is titled "Cost breakdown", and "outcome" is this component's own noun
 * (`OutcomeTrack`, `outcomeLabel`, "Selected-cycle outcome evidence…").
 */
export const BRANCH_OUTCOME_BREAKDOWN_TITLE = "Outcome breakdown";

/**
 * The selector's sentence for pull-request history it could not read.
 *
 * Exported HERE, and imported by both the selector and the headline cards,
 * because ISS-6957 needs the cards to say exactly what the control two inches
 * above them already says. Two copies of a sentence that must agree is the drift
 * this module exists to prevent — the selector itself declared it twice.
 */
export const BRANCH_PULL_REQUEST_HISTORY_UNAVAILABLE =
  "Pull request history isn't available yet.";

/**
 * ISS-6957: why a pull-request-cycle card has no value, when the reason is the
 * pull request rather than the evidence. `null` when a pull request IS selected,
 * so the caller keeps its own availability copy.
 *
 * "Evidence is unavailable." means we looked and could not find it. On a branch
 * with no selected pull request that sends a reader hunting for a data problem
 * that does not exist, when the page already knows the real answer — it is
 * rendering the pull-request control that resolves it.
 *
 * The three cases stay THREE, because collapsing them is the same defect one
 * rung down: something selectable and unselected is the reader's next action; a
 * branch that provably has no pull request is not applicable and never will be;
 * and history we could not read is a genuine outage the control cannot fix, so
 * it must not be dressed up as an action.
 *
 * ONLY for metrics scoped to the selected pull-request CYCLE. "LOC per $" is
 * measured over the Branch lifetime — its own tooltip says selecting a pull
 * request does not change it — so naming a pull request as its blocker would
 * swap one wrong sentence for another.
 *
 * A SELECTION IS ALSO A COLLECTION FACT, not only a projection one, and the two
 * disagree exactly where this function must not guess. Desktop's
 * `suppressMismatchedSelectedPullRequest` answers version skew — a newer
 * renderer asking an older main for an explicit pull request it silently ignores
 * — by withholding the PR-owned projection and the cycle metrics while leaving
 * the collection, `selectedId` included, standing. Reading only the projection
 * there reports a reader who HAS selected a pull request as one who has not, and
 * offers an action that changes nothing. `selectedId` is the collection's own
 * statement that something is selected, so it keeps that case an outage.
 */
export function branchPullRequestCycleAbsence(
  collection: BranchAssociatedPullRequestCollection | undefined,
  hasSelectedPullRequest: boolean
): { detail: string; label: string } | null {
  if (hasSelectedPullRequest || (collection?.selectedId ?? null) !== null) {
    return null;
  }
  if ((collection?.items.length ?? 0) > 0) {
    return {
      detail: "Select a pull request to see this.",
      label: "No PR selected",
    };
  }
  if (
    collection?.completeness.state ===
    BranchAssociatedPullRequestCompletenessState.Complete
  ) {
    return { detail: "This branch has no pull request.", label: "N/A" };
  }
  return {
    detail: BRANCH_PULL_REQUEST_HISTORY_UNAVAILABLE,
    label: "Unavailable",
  };
}

/**
 * The waterfall's sentence when a pull request IS selected and its cycle still
 * has no track. Shipped copy, unchanged — hoisted here only so the section and
 * the cards it decomposes read their absent-state wording from one module, which
 * is what stops a future edit fixing one and leaving the other behind.
 */
export const BRANCH_OUTCOME_EVIDENCE_ABSENT =
  "Selected-cycle outcome evidence is unavailable or not applicable.";

/**
 * ISS-8422: the word a pull request wears when nobody has observed its state.
 *
 * `pull_request_detail.pr_state` is `NOT NULL` with `@default(OPEN)`, so a row
 * the desktop lane wrote the moment a PR was opened reads OPEN without anyone
 * having measured it. The API now emits `prState: null` for such a row rather
 * than restate that default as a reading, and this is what the render says
 * instead — a WORD, because the badge's only other signal is hue and muted is
 * equally what a genuinely unknown state gets (WCAG 1.4.1).
 *
 * Not "Awaiting sync": that vocabulary is already spoken by the branch lead
 * cell for `BranchDataState.AwaitingSync` and promises motion this state cannot
 * guarantee — a PR number GitHub will never resolve never stops being
 * unconfirmed. Decision by Kerensa Whitlock, 2026-08-31.
 */
export const BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL = "Unconfirmed";

/**
 * The sentence that explains {@link BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL}.
 *
 * Carried, with a leading comma, as the `sr-only` tail of the badge's
 * accessible name: the visible word plus this sentence ARE the name, and no
 * `aria-label` replaces them.
 *
 * The construction is `EmptyCount`'s (`count-cell.tsx`), NOT
 * `ExplainedPropertyValue`'s — an earlier draft cited the latter and did not
 * ship it. That component portals a DS `Tooltip` off a real `<button>`
 * precisely so the sentence is reachable by keyboard and touch; a table cell
 * chip is a `<span>` on one arm, so it would have been a claim the code did not
 * honour. It also does NOT go in `title`: `title` loses the name computation to
 * the element's contents and then reappears as the accessible DESCRIPTION, so
 * the sentence was read twice (the ISS-7737 defect).
 */
export const BRANCH_PULL_REQUEST_UNCONFIRMED_EXPLANATION =
  "GitHub hasn't reported this pull request's state yet.";

/**
 * The selector's caveat when the pull request it has SELECTED is the unobserved
 * one. Every card below the control derives from that pull request, so a reader
 * who does not open the dropdown would otherwise see a panel of absent values
 * with nothing saying why.
 *
 * A sentence, not a repeat of the dropdown's word: this is the `aria-live`
 * description under the control, and it has room to say what the word cannot.
 *
 * "the details below", not "its": the nearest noun is "state", so "its" lands
 * for a beat as the state's details. "unavailable", not "incomplete", because
 * that is the word the cards directly underneath already print
 * (`branch-headline-cards.tsx`) — a third synonym leaves the reader to map it.
 * The hedge stays: a row minutes behind can still resolve, so a flat "are
 * unavailable" would be the new false statement.
 */
export const BRANCH_PULL_REQUEST_UNCONFIRMED_SELECTED =
  "GitHub hasn't reported this pull request's state yet, so the details below may be unavailable.";

/**
 * The waterfall's footnote when the phase evidence is incomplete for any reason
 * other than a read cap: some evidence was malformed, unpriced, or missing.
 */
export const BRANCH_OUTCOME_EVIDENCE_INCOMPLETE_FOOTNOTE =
  "* Calculated from available selected-cycle evidence.";

/**
 * ISS-9862: the footnote when the reason is `CoverageCapped` — the read hit its
 * row limit, so evidence past that limit was never read. That is a different
 * fact from "some evidence was unusable", and the generic sentence above hid
 * it: a reader could not tell a capped read from a malformed one. The
 * attribution fold ranks `CoverageCapped` second in precedence, so this fires
 * whenever the cap is the top reason.
 */
export const BRANCH_OUTCOME_EVIDENCE_CAPPED_FOOTNOTE =
  "* Calculated from selected-cycle evidence up to a read limit; evidence past it is not included.";

export const BRANCH_OUTCOME_IDLE_UNAVAILABLE_SUMMARY = "idle unavailable";

export const BRANCH_OUTCOME_IDLE_UNAVAILABLE_FOOTNOTE =
  "Idle evidence is unavailable.";

/** An open pull request GitHub marks as a draft (the PR picker's word). */
export const BRANCH_PULL_REQUEST_DRAFT_LABEL = "Draft";
