/**
 * ISS-5075 (stage VQA review): ONE phrasing for "the stored event stream was cut
 * before the end", shared by every surface that draws the resulting prefix — the
 * Session Trace header count, the end of the rendered trace, the Session
 * Timeline strip, and the Branch combined-trace header.
 *
 * Before this module those four sites each said it their own way, in our words
 * rather than the reader's ("stored event stream exceeded the detail read
 * limit"), so one condition spoke five different ways on two screens. The
 * vocabulary is the one the Activity phases panel had already settled on for the
 * same condition ("later phases truncated", "2 phases couldn't be read"): terse
 * fragments, joined with a middot, no em dashes, and no internal names for our
 * own read limits. ISS-7867 retired that panel; the shape it set is what these
 * surviving surfaces still share.
 *
 * Two registers live here. The fragments above ride a header count or a strip
 * caption. The whole sentences ({@link TRACE_TOO_MANY_EVENTS_TO_PLOT},
 * {@link TRACE_LATER_ACTIVITY_UNREAD_LEGEND}) stand alone or join the Session
 * Timeline legend line, whose other members are sentences too.
 */
export const TRACE_EVENTS_TRUNCATED_NOTE = "later events truncated";

/**
 * The Branch combined-trace header's version, and the ONE place the vocabulary
 * deliberately diverges.
 *
 * `BranchTraceCompleteness.eventsTruncated` is true when ANY ONE of the N
 * hydrated sessions contributed a prefix (`branch-trace-service.ts`), and
 * `buildMergedTrace` interleaves those sessions chronologically — so the cut is
 * INTERIOR to the merged rows, not at their end. {@link
 * TRACE_EVENTS_TRUNCATED_NOTE} would tell the reader this whole trace stops
 * early, which is the same over-claim the rest of this change removes. Stated
 * without a scope the reader has to reconstruct, and without naming our read
 * limit.
 */
export const TRACE_BRANCH_EVENTS_TRUNCATED_NOTE = "some events not read";

/**
 * The note at the END of the rendered rows, where a reader scrolling a long
 * trace meets the cut. Leads with what just happened to them (the rows stopped)
 * before the shared fragment names why.
 */
export const TRACE_END_OF_READ_NOTE = `End of what we could read · ${TRACE_EVENTS_TRUNCATED_NOTE}`;

/**
 * The Session Timeline's own EMPTY state: truncated so hard that no bucket
 * survived to plot. The only thing on screen where a chart should be, so it is
 * a whole sentence rather than a fragment.
 */
export const TRACE_TOO_MANY_EVENTS_TO_PLOT =
  "This session had too many events to plot.";

/**
 * Legend for the strip's unread tail. The region past the last plotted bucket
 * carries its own treatment (`.sd3-bar2.unread`), distinct from the idle hatch,
 * so the caption only has to name it — the encoding, not the caption, is what
 * stops an unread tail reading as a quiet one.
 */
export const TRACE_UNREAD_TAIL_LEGEND = `Shaded: ${TRACE_EVENTS_TRUNCATED_NOTE}`;

/**
 * The same fact with nothing to point at: the strip's own caption when the axis
 * stops at the last plotted bucket, so there is no unread tail on screen to
 * label. A legend for a region that is not drawn would be its own small lie.
 */
export const TRACE_EVENTS_TRUNCATED_CAPTION = "Later events truncated";

/**
 * ISS-9858: the Session Timeline legend's note when the detail read hit the
 * stored activity-tiling ceiling (`AgentSessionDetail.activitySegmentRowsTruncated`).
 *
 * A DIFFERENT fact from {@link TRACE_EVENTS_TRUNCATED_CAPTION}, and worded to
 * stay different. That one is about the EVENT stream the bars and dots are
 * plotted from. This one is about the activity TILING, which sizes the axis
 * window: a start-ordered prefix can end before the session does, so the axis
 * drawn from it may stop early. Both can be true of one session and both then
 * render, one on the strip and one on the legend line beneath it.
 *
 * "May", not "does": the axis window is a union with the plotted rows, so a
 * transcript that continues past the prefix still widens it. The sentence
 * claims what the flag establishes (later rows were not read) and hedges what
 * it does not (whether the axis was shortened).
 */
export const TRACE_LATER_ACTIVITY_UNREAD_LEGEND =
  "Later activity was not read, so the timeline may end early.";

/**
 * ISS-5636: what the session-detail Properties rows say about a counter folded
 * out of the served prefix — `AgentSessionDetail.autonomyTruncated` and
 * `steeringEpisodesTruncated`, each scoped to the derivation it describes, plus
 * `eventsTruncated` for the turn count's event-derived fallback.
 *
 * Those rows state a bare number with no chrome around it to qualify — the
 * trace's header, end-of-read note, and timeline caption above all sit on the
 * rendered rows and can point at the cut, but "Guided autonomy | 41/100" has
 * nothing to point at. So the qualifier rides the row's ISS-5581 `explanation`
 * sentence, and reuses {@link TRACE_EVENTS_TRUNCATED_NOTE} verbatim rather than
 * saying the same condition a sixth way.
 *
 * A COMPLEMENT, not a whole sentence: the caller supplies the subject and its
 * verb, because the Autonomy row's subject is one field ("Autonomy was …") and
 * the Work row's is a list of counters ("Turns and steering episodes were …").
 */
export const TRACE_PREFIX_COUNTED_NOTE = `counted over the events we could read · ${TRACE_EVENTS_TRUNCATED_NOTE}`;

/**
 * ISS-9723: the Branch combined-trace header's note for items the merged-trace
 * contract could not parse, which were therefore dropped from the rows below it.
 *
 * A SEPARATE fact from {@link TRACE_BRANCH_EVENTS_TRUNCATED_NOTE}, and worded to
 * stay separate. That one means events we never read; this one means events we
 * read and could not understand. Both can be true of one trace, and one wording
 * for both would tell the reader one thing about two different gaps.
 *
 * States the COUNT rather than hedging, because the count is what makes the gap
 * legible: a trace missing one entry and a trace missing forty are different
 * things to be looking at. Same terse-fragment grammar as its siblings, and no
 * fabricated stand-in for what was dropped — those rows are simply not there.
 *
 * "Entries", not "events", and the noun is load-bearing twice over: what is
 * counted is TRACE ENTRIES, and one of them can coalesce a whole run of source
 * events — so calling them events would undercount the gap it names. It also
 * keeps this fragment from reading as a restatement of the truncation note
 * beside it, which counts events we never read.
 */
export function traceBranchUnreadableItemsNote(count: number): string {
  return `${count} ${count === 1 ? "entry" : "entries"} unreadable`;
}
