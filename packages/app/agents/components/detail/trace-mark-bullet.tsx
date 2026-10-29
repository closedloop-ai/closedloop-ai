"use client";

import { cn } from "@repo/design-system/lib/utils";
import { createContext, type ReactNode, useContext } from "react";
import type { DotColor } from "./activity-dot-rendering";
import { SessionTimelineMarkSwatch } from "./session-timeline-mark-swatch";

/**
 * Which timeline the transcript sits under. `SessionTrace` is shared: Session
 * detail renders it under the Session Timeline, whose rail draws the ISS-12117
 * marks (own palette and shapes), and Branch detail renders it under the
 * Branch timeline (`branch-event-dot-rail.tsx`), which still draws round
 * `--destructive` / `--success` dots. A transcript bullet must match the dot
 * a reader clicked to reach it, so it follows the rail above it. The Branch
 * rail moving to the new marks is ISS-12180.
 */
export const TraceMarkPalette = {
  /** The Session Timeline's marks: own palette, one shape per lane. */
  SessionTimeline: "session-timeline",
  /** The Branch timeline's round dots in the shared tokens. */
  BranchTimeline: "branch-timeline",
} as const;
export type TraceMarkPalette =
  (typeof TraceMarkPalette)[keyof typeof TraceMarkPalette];

const TraceMarkPaletteContext = createContext<TraceMarkPalette>(
  TraceMarkPalette.SessionTimeline
);

/** Sets the palette for every transcript bullet below it. */
export function TraceMarkPaletteProvider({
  children,
  palette,
}: Readonly<{ children: ReactNode; palette: TraceMarkPalette }>) {
  return (
    <TraceMarkPaletteContext.Provider value={palette}>
      {children}
    </TraceMarkPaletteContext.Provider>
  );
}

/** The Branch rail's round bullet classes (`styles.css`). */
const BRANCH_BULLET_CLASS: Readonly<Record<DotColor, string | null>> = {
  b: null,
  g: "d-g",
  r: "d-r",
};

/** A transcript row's bullet, in the palette of the timeline above it. */
export function TraceMarkBullet({ color }: Readonly<{ color: DotColor }>) {
  const palette = useContext(TraceMarkPaletteContext);
  if (palette === TraceMarkPalette.BranchTimeline) {
    return (
      <span
        aria-hidden
        className={cn("st-sys-dot", BRANCH_BULLET_CLASS[color])}
      />
    );
  }
  return <SessionTimelineMarkSwatch className="st-sys-dot" color={color} />;
}
