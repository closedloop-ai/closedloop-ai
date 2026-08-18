/**
 * ISS-5075 (stage VQA review): ONE phrasing for "the stored event stream was cut
 * before the end", shared by every surface that draws the resulting prefix — the
 * Session Trace header count, the end of the rendered trace, the Session
 * Timeline strip, and the Branch combined-trace header.
 *
 * Before this module those four sites each said it their own way, in our words
 * rather than the reader's ("stored event stream exceeded the detail read
 * limit"), so one condition spoke five different ways on two screens. The
 * vocabulary is the one the Activity phases panel already settled on for the
 * same condition (`session-activity-segments.tsx`: "later phases truncated",
 * "2 phases couldn't be read"): terse fragments, joined with a middot, no em
 * dashes, and no internal names for our own read limits.
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
