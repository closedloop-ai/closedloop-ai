"use client";

import {
  SessionTimelineSummary,
  type SessionTimelineSummarySession,
} from "@repo/app/agents/components/detail/session-timeline-summary";
import type { ReactNode } from "react";

/**
 * The Session Timeline's header: its landmark, its title, and the run-level
 * summary that trails the title.
 *
 * Extracted from `agent-session-detail-view.tsx` (ISS-5970), which is
 * grandfathered under the file-size ceiling and therefore shrink-only — adding
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
}: Readonly<{ children: ReactNode }>) {
  return (
    <section aria-labelledby={SESSION_TIMELINE_HEADING_ID}>{children}</section>
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
  summarySession,
}: Readonly<{
  /** ISS-5970: the session the run-level summary reads. */
  summarySession: SessionTimelineSummarySession;
}>) {
  return (
    <div className="sd3-act-head">
      <h2 className="sd3-act-title" id={SESSION_TIMELINE_HEADING_ID}>
        Session Timeline
      </h2>
      <SessionTimelineSummary session={summarySession} />
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
