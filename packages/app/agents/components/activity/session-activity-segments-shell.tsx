"use client";

import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

/**
 * FEA-4238: the disclosure chrome for the Activity phases strip, extracted from
 * `session-activity-segments.tsx` so that grandfathered-adjacent file stays lean
 * and this cohesive unit (header + fold state + legend/note placement) lives on
 * its own.
 *
 * The strip is ALWAYS a disclosure — the same "Activity phases" header carries a
 * chevron on every session, so the control never appears-and-disappears between
 * sessions. It defaults OPEN when the session has a real working stretch and
 * defaults COLLAPSED when idle dominates (a long wall-clock span the agent slept
 * through — e.g. a 66h run — whose strip is ~98% empty hatch and reads broken
 * front-loaded above the trace). Either way the reader can fold or unfold.
 *
 * The chevron is the same lucide `ChevronRight`/`ChevronDown` at `size-3.5` that
 * every other disclosure on the session-detail screen uses (trace rows, subagent
 * blocks, the thinking block, the reason toggle), so the screen shows ONE
 * disclosure glyph rather than a platform-dependent unicode triangle beside it.
 *
 * Legend/note placement across the fold (FEA-4238 review):
 * - the legend keys fills; it is meaningless when the strip is folded, so it
 *   renders in the disclosure BODY (visible only when open), never the summary.
 * - the honest caveat notes (`N% idle`, `later phases truncated`,
 *   `N phases couldn't be read`) are exactly what must survive a fold, so they
 *   render on the always-visible summary itself.
 */
export function ActivitySegmentsShell({
  children,
  count,
  defaultOpen,
  legend,
  summaryNotes,
  truncated,
}: Readonly<{
  children: ReactNode;
  count?: string;
  /**
   * Initial fold state: open for a session with real work, collapsed when idle
   * dominates. The reader's later toggle takes over from here.
   */
  defaultOpen: boolean;
  legend?: ReactNode;
  /**
   * The always-visible honest caveats rendered on the summary (e.g. "98% idle",
   * "later phases truncated · 2 phases couldn't be read") so a folded strip still
   * states its caveats without being expanded.
   */
  summaryNotes?: readonly string[];
  truncated?: boolean;
}>) {
  const [open, setOpen] = useState(defaultOpen);
  const notes = summaryNotes?.filter((note) => note.length > 0) ?? [];

  return (
    <section
      aria-label="Activity phases"
      className="sd3-segs"
      data-truncated={truncated ? "true" : undefined}
    >
      <button
        aria-expanded={open}
        className="sd3-act-head sd3-segs-head sd3-segs-summary"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {/* Header uses the Session Timeline convention (.sd3-act-head/.sd3-act-title)
            so the two meta-sections read as siblings rather than two conventions.
            Title + chevron form the left group; the count + notes sit in the
            right slot that .sd3-act-head lays out via space-between. */}
        <span className="sd3-segs-titlegroup">
          <span className="sd3-act-title">Activity phases</span>
          {open ? (
            <ChevronDownIcon aria-hidden className="sd3-segs-chev size-3.5" />
          ) : (
            <ChevronRightIcon aria-hidden className="sd3-segs-chev size-3.5" />
          )}
        </span>
        <span className="sd3-segs-headmeta">
          {notes.length > 0 ? (
            <span className="sd3-segs-summary-note">{notes.join(" · ")}</span>
          ) : null}
          {count ? <span className="sd3-th-count">{count}</span> : null}
        </span>
      </button>
      {open ? (
        <div className="sd3-segs-disclosed">
          {legend ? <div className="sd3-segs-legendrow">{legend}</div> : null}
          {children}
        </div>
      ) : null}
    </section>
  );
}
