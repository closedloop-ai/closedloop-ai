import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { SessionEvidenceCoverage } from "@repo/api/src/types/session-evidence-coverage-constants";
import { TRACE_LATER_ACTIVITY_UNREAD_LEGEND } from "@repo/app/shared/lib/trace-truncation-copy";

/**
 * ISS-7427 (AC5): whether the Session Timeline strip may claim to have covered
 * the session, and the caption that withdraws the claim when it may not.
 *
 * Split into its own leaf rather than added to `session-detail-workspace.tsx`
 * for the reason `session-trace-header.ts` was: the workspace is a shrink-only
 * view, and this is a pure decision with no JSX in it, so it is testable without
 * mounting anything.
 */

/**
 * The withdrawal, one line, rendered under the strip.
 *
 * IT CLAIMS ONLY THE BARS' POPULATION, and that restraint is the design rather
 * than brevity. An earlier draft ended "— no archived transcript exists to
 * measure the rest", which is FALSE on two reachable shapes of the very state
 * that gates it. `readableSubagentTranscriptCount > 0` is one of the four
 * signals that PRODUCE `metadataOnly` (`hasIndependentEvidence`), and the main
 * file is the one the per-file size cap rejects first — so the sentence would
 * have denied the existence of archives whose chips `TranscriptFileSwitcher` was
 * offering directly above it. And on desktop a `permanentlyUnavailable` cloud
 * descriptor still resolves the on-disk `.jsonl`, so the panel can paint the
 * whole main transcript under "Showing your local copy" while the caption says
 * nothing exists. This is the trap `session-trace-header.ts` documents for the
 * sibling note: a claim about what EXISTS is surface-dependent, a claim about
 * what a value COUNTED is not.
 *
 * IT ALSO DOES NOT ASSERT A SHORTFALL, and that is the second restraint. An
 * earlier draft ended "— not the whole session", which states as fact that some
 * activity is missing from the strip. Nothing in the gate establishes that:
 * `metadataOnly` says the MAIN TRANSCRIPT is permanently unavailable and some
 * independent evidence exists, and `bucketCount > 0` says bars were drawn.
 * Neither rules out a metadata lane that captured every interval, in which case
 * the bars DO span the run and the sentence was simply false. What the gate does
 * establish is that nothing will ever measure the difference — so the honest
 * claim is UNVERIFIABILITY, not absence. "May not span" is true on both shapes;
 * "does not span" is true on only one of them. Withdrawing an overclaim with a
 * second overclaim would be self-defeating for a ticket whose whole subject is
 * this.
 *
 * Proposed wording. The gate below is closed by default and the final phrasing
 * is the operator's call, not this module's.
 */
export const TIMELINE_EVIDENCE_COVERAGE_LEGEND =
  "Bars cover synced activity only, which may not span the whole session.";

export type TimelineCoverageDisclosureInput = {
  /**
   * How many bars the strip is about to draw. A strip with no bars makes no
   * coverage claim, so there is nothing to withdraw and captioning it would be a
   * sentence about an absent element.
   */
  bucketCount: number;
  /** The resolved gate, as `useFeatureFlagEnabledOptional` returns it. */
  disclosureEnabled: boolean;
  /**
   * The server's verdict, straight off the detail response.
   *
   * `undefined` means THIS SERVER DOES NOT CLASSIFY (a version-skewed
   * `apps/api`, or the desktop-local projection, which never sets it) — never
   * "the main archive is readable". An unclassified response therefore says
   * nothing rather than guessing a state, matching the wire contract on
   * `AgentSessionDetail.evidenceCoverage`.
   */
  evidenceCoverage: AgentSessionDetail["evidenceCoverage"];
};

/**
 * Resolve the strip's coverage caption, or `null` for every state that may not
 * carry one.
 *
 * The SENTENCE is true of every session — the strip only ever tiles what the
 * metadata lane holds rows for, so "covers synced activity only" is a statement
 * about the bars' POPULATION, and "may not span the whole session" is a
 * statement about what that population was never checked against. Neither
 * asserts that a gap exists; see the constant's note for why the stronger form
 * was withdrawn.
 *
 * What `metadataOnly` adds is that the uncertainty is PERMANENT: on every other
 * state a reader who wants to check the uncovered time can go and get it, so a
 * standing caption would be noise on every healthy session. Gated on that state
 * alone, and the four exclusions are the point of the ticket:
 *
 * - `mainReadable` — the archive is there, so the uncovered time is recoverable
 *   by opening it. `stale` rides this state too: readable but behind is still
 *   readable.
 * - `pending` — nothing has been ruled out; the archive that closes the gap may
 *   still land, and saying otherwise would be a false claim about the future. (A
 *   `metadata`-sync-tier device whose transcript is never queued also lands here
 *   and never leaves, so it gets no caption. That conflation is upstream in
 *   `deriveTranscriptDisposition`, which has no vocabulary for "the lane is off
 *   for this device", and belongs to ISS-7516 rather than being forked here.)
 * - `noEvidence` — every independent signal is empty, so there are no bars, and
 *   {@link TimelineCoverageDisclosureInput.bucketCount} would refuse it anyway.
 * - `notApplicable` — no transcript was ever expected, so its absence carries no
 *   information about the strip.
 */
export function resolveTimelineCoverageLegend(
  input: TimelineCoverageDisclosureInput
): string | null {
  if (!input.disclosureEnabled) {
    return null;
  }
  if (input.evidenceCoverage !== SessionEvidenceCoverage.MetadataOnly) {
    return null;
  }
  if (input.bucketCount <= 0) {
    return null;
  }
  return TIMELINE_EVIDENCE_COVERAGE_LEGEND;
}

/**
 * Fold the strip's withdrawals into ONE caption line, or `null` when it has
 * none.
 *
 * They are separate facts about separate properties — the synthesized-cost
 * legend withdraws the bars' HEIGHTS, this ticket's withdraws their EXTENT — and
 * each carries its own flag, so any subset can be live at once. Rendered as
 * sibling paragraphs they were the same size, colour and left edge four pixels
 * apart, which reads as one sentence that wrapped rather than as two facts.
 * `getTraceCountLabel` already solved exactly this for the trace heading's
 * truncation and evidence notes, so this borrows its middot instead of inventing
 * a second answer to the same question.
 *
 * A single surviving note is returned VERBATIM, so a strip carrying only the
 * pre-existing cost legend renders the byte-identical line it renders today.
 */
export function composeTimelineLegend(
  notes: readonly (string | null)[]
): string | null {
  const present = notes.filter((note): note is string => note !== null);
  return present.length === 0 ? null : present.join(LEGEND_SEPARATOR);
}

/** Joins the strip's independent withdrawals, matching `getTraceCountLabel`. */
const LEGEND_SEPARATOR = " · ";

export type TimelineTruncatedTilingInput = {
  /** How many bars the strip drew; see {@link TimelineCoverageDisclosureInput.bucketCount}. */
  bucketCount: number;
  /**
   * `AgentSessionDetail.activitySegmentRowsTruncated`, straight off the detail.
   * Only `true` is a claim; `false`, `null` and `undefined` all mean the read
   * did not hit its ceiling (or the server predates the field).
   */
  rowsTruncated: boolean | null | undefined;
};

/**
 * ISS-9858: the legend's note when the stored activity tiling was served as a
 * prefix. The tiling sizes the axis window (`getPhaseTilingSpan`), so a cut
 * tiling can end the axis before the session ended, with nothing on screen to
 * say so — the constant's own doc in `agent-session.ts` promised this
 * disclosure and no component rendered it.
 *
 * Same zero-bar rule as {@link resolveTimelineCoverageLegend}: a strip that
 * drew nothing already says so in its own words, and a sentence about the
 * timeline ending early beside "No activity recorded" would be two claims about
 * an element that is not there.
 *
 * Ungated on purpose (brief ruling, ISS-9858): the flag is a read-side
 * backstop no shipped producer reaches, so the note is a disclosure of a state
 * that should not occur, not a rollout.
 */
export function resolveTimelineTruncatedTilingLegend(
  input: TimelineTruncatedTilingInput
): string | null {
  if (input.rowsTruncated !== true) {
    return null;
  }
  if (input.bucketCount <= 0) {
    return null;
  }
  return TRACE_LATER_ACTIVITY_UNREAD_LEGEND;
}
