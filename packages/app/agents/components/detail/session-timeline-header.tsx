"use client";

import {
  SessionTimelineSummary,
  type SessionTimelineSummarySession,
} from "@repo/app/agents/components/detail/session-timeline-summary";
import type { TimelinePeakBucket } from "@repo/app/agents/components/detail/timeline-peak-bucket-fact";
import type { ReactNode } from "react";

/**
 * The Session Timeline's header: its landmark, its title, and the run-level
 * summary that trails the title.
 *
 * Extracted from `agent-session-detail-view.tsx` (ISS-5970) — adding
 * the summary slot to the heading there would have grown it. These three pieces
 * are one cohesive unit anyway: they are the region, the thing that names it,
 * and the facts printed beside that name, and nothing else in the view reads
 * them.
 */

/**
 * ISS-5818 (D5): the Session Timeline's landmark, matching the prototype's
 * `session-timeline.tsx:449` — `<section aria-labelledby>` around the strip,
 * named by the `h2` {@link SessionTimelineHeading} renders.
 *
 * A wrapper rather than a `className` swap because the region IS the element: a
 * `div` cannot carry a region role, and `aria-labelledby` on a generic element
 * names nothing.
 */
export function SessionTimelineRegion({
  children,
  describedById,
}: Readonly<{
  children: ReactNode;
  /**
   * ISS-7427 AC5: the id of the caption that WITHDRAWS part of this region's
   * claim, when one is rendered.
   *
   * The caption cannot live inside the region — FEA-4025 keeps it below the
   * pinned box — so without this a screen-reader user enters "Session Timeline",
   * hears every bar, leaves, and only then meets the sentence taking the strip's
   * coverage back. `aria-describedby` resolves an IDREF anywhere in the
   * document, so the association survives the placement.
   *
   * Omitted, not empty, when there is no caption: `aria-describedby=""` names a
   * missing element rather than nothing.
   */
  describedById?: string;
}>) {
  return (
    <section
      aria-describedby={describedById}
      aria-labelledby={SESSION_TIMELINE_HEADING_ID}
    >
      {children}
    </section>
  );
}

/**
 * ISS-5818 (D5): the Session Timeline's title, as the real `h2` that names the
 * landmark {@link SessionTimelineRegion} draws.
 *
 * The TEXT is deliberately unchanged. "Session Timeline" should read "Session
 * Costs Over Time" per PRD-575, but that is ISS-5129's ticket. `sd3-act-title`
 * carries the styling, so the heading does not inherit a browser `h2`'s default
 * size.
 */
export function SessionTimelineHeading({
  peakBucket,
  summarySession,
}: Readonly<{
  /** ISS-12665: the strip's peak column — see `SessionTimelineSummary`. */
  peakBucket: TimelinePeakBucket | null;
  /** ISS-5970: the session the run-level summary reads. */
  summarySession: SessionTimelineSummarySession;
}>) {
  return (
    <div className="sd3-act-head">
      <h2 className="sd3-act-title" id={SESSION_TIMELINE_HEADING_ID}>
        Session Timeline
      </h2>
      <SessionTimelineSummary
        peakBucket={peakBucket}
        session={summarySession}
      />
    </div>
  );
}

/**
 * ISS-5818 (D5): the id the Timeline landmark is named by. A shared constant
 * rather than an inline literal because it is written in two places — the
 * `section[aria-labelledby]` and the heading's own `id` — and a typo in either
 * silently produces an UNNAMED region, which is worse than no landmark: a
 * screen-reader user gets an entry in the landmark list with nothing in it.
 */
export const SESSION_TIMELINE_HEADING_ID = "session-timeline-heading";

/**
 * ISS-7427 AC5: the id the Timeline's caption line carries so
 * {@link SessionTimelineRegion} can point `aria-describedby` at it. A shared
 * constant for the same reason {@link SESSION_TIMELINE_HEADING_ID} is one — it
 * is written in two files, and a typo in either silently produces a region
 * described by nothing.
 */
export const SESSION_TIMELINE_LEGEND_ID = "session-timeline-legend";
