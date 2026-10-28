import type { DocumentType } from "./document.ts";

/**
 * ISS-8936 — the four counts the Documents index summary band renders, measured
 * server-side over the SAME predicate the list is drawn from.
 *
 * SERVER-SIDE, and that is the whole contract rather than an implementation
 * detail. The index has two reads (`documents-index-paged`): one unbounded, one
 * a single server page. Deriving these counts from the rows the browser holds
 * would reconcile on the first and lie on the second — a "Total Documents" of 50
 * beside a pager reading "1–50 of 412". So the counts are measured where the
 * whole population is, under one snapshot, and the band states what the server
 * counted.
 */

/**
 * The freshness window, in days, {@link DocumentListSummary.updatedInWindow} is
 * measured over.
 *
 * Seven, because the card says "this week" and a reader checking a list's
 * freshness is asking about the working week they are in. It travels on the wire
 * as {@link DocumentListSummary.windowDays} rather than being re-spelled in the
 * client: the caption names the window the count was actually taken over, so the
 * two cannot drift into a card describing a different week than the one measured.
 */
export const DOCUMENT_SUMMARY_WINDOW_DAYS = 7;

export type DocumentListSummary = {
  /** Acknowledges exact-cohort narrowing for version-skewed readers. */
  appliedArtifactIds?: string[];
  /** Daily activity in the current cohort, not historical cohort snapshots. */
  trendlines?: DocumentSummaryTrendlines;
  /** Present when this server applied the additive union subtype filter. */
  appliedTypes?: DocumentType[];
  /**
   * Every artifact matching the query — the population the list shows, and the
   * denominator the other three are read against.
   */
  total: number;
  /**
   * Of {@link total}, how many an agent session PRODUCED: the artifact carries a
   * `PRODUCES` link from a SESSION artifact in the same organization.
   *
   * PRODUCTION provenance specifically, not "a session touched this". That is
   * the fact PRD-695 names ("Documents produced by agent sessions") and it is
   * also the only provenance kind decidable from the link row alone —
   * `classifySessionLinkKind` resolves `PRODUCES` with no metadata read, where
   * contribution and comment need per-row classification that a `count()` cannot
   * express. A count that quietly widened to every touched document would
   * overstate the very measure the relaunch is graded on.
   */
  producedByAgentSessions: number;
  /** Of {@link total}, how many were updated within {@link windowDays}. */
  updatedInWindow: number;
  /**
   * Of {@link total}, how many have never been written since they were created —
   * `DocumentDetail.latestVersion <= 1`, the version a create writes.
   *
   * This is PRD-695's "create succeeded → first meaningful body edit saved"
   * funnel step, counted from the other end: a document that exists and holds
   * nobody's writing. `<= 1` rather than `=== 1` so a row whose counter was
   * never written still counts as unedited rather than falling out of both arms.
   */
  neverEdited: number;
  /** The window {@link updatedInWindow} was measured over, in days. */
  windowDays: number;
};

/** Fourteen UTC calendar days ending at the request's captured instant. */
export const DOCUMENT_METRIC_TREND_DAYS = 14;

export type DocumentSummaryTrendlines = {
  startDate: string;
  endDate: string;
  /** Current-cohort artifact creations per UTC day. */
  total: number[];
  /** First recorded qualifying production link per current-cohort artifact. */
  producedByAgentSessions: number[];
  /** Current-cohort latest update timestamps per UTC day, not all past edits. */
  updatedInWindow: number[];
};

export function documentMetricTrendStart(now: Date): Date {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - DOCUMENT_METRIC_TREND_DAYS + 1
    )
  );
}

/** Bounded exact-cohort summary requests; clients combine disjoint chunks. */
export const DOCUMENT_SUMMARY_ID_BATCH_SIZE = 100;
