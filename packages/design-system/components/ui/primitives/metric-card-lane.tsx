import type { ReactNode } from "react";
import { cn } from "@closedloop-ai/design-system/lib/utils";

/**
 * A breakdown lane beneath a {@link MetricCard} value: a named part of the
 * headline, its optional share of that headline, and its own figure.
 *
 * This primitive owns the GEOMETRY and nothing else. What the lanes mean, how
 * they are classified, whether they reconcile, and what any of them is called
 * belong to the consumer — the design system is a project-agnostic package and
 * is gated from importing domain code.
 *
 * ## Why the grid lives on the LIST, not on each row
 *
 * The share column is the one a reader scans down to compare one lane against
 * another, so it must not drift laterally row to row. A per-row grid can only
 * guarantee that with FIXED track widths, and a fixed figure track is a
 * clipping hazard: `value` is an arbitrary `ReactNode`, so a long enough
 * formatted figure paints left out of its track and over the share beside it.
 *
 * Putting the tracks on the list and letting each lane contribute its three
 * cells directly (the lane renders a fragment, so no wrapper element interrupts
 * the grid) gets both properties at once: every row resolves against the SAME
 * tracks, and those tracks size to the widest content in the list rather than a
 * guess made in this file.
 */
export type MetricCardLaneProps = {
  /** The lane's name. Wraps rather than truncating — see the note below. */
  label: ReactNode;
  /** The lane's figure, already formatted by the consumer. */
  value: ReactNode;
  /** Optional share of the headline, already formatted (e.g. "12.4%"). */
  share?: ReactNode;
  /**
   * De-emphasizes the LABEL only; the figure keeps full weight either way.
   *
   * The test is structural, not a judgment about the number: mute a lane only
   * when it STANDS IN FOR TWO OR MORE lanes this same list names when the
   * source can split them — a "Not subscription-covered" remainder beside the
   * split it replaces. Never a terminal category of the breakdown, however
   * uncertain or unwelcome its subject.
   *
   * Stated that way because "not a figure in its own right" reads both ways on
   * the case that prompted this: a bucket the source could not classify is
   * uncertain, but it is still one of the categories the list enumerates, and
   * receding it under-states a fact the breakdown exists to state.
   */
  muted?: boolean;
  /** Extra classes for the label cell. */
  className?: string;
};

export function MetricCardLane({
  label,
  value,
  share,
  muted = false,
  className,
}: MetricCardLaneProps) {
  return (
    <>
      {/* WRAPS, never truncates. `truncate` is `overflow:hidden`, so a label
          carrying its own affordance (an info trigger explaining what the lane
          is) loses that affordance at exactly the widths where the label has
          already stopped explaining itself. The `minmax(0, 1fr)` label track is
          what lets it wrap instead of forcing the row wider. */}
      <dt
        className={cn(
          "min-w-0 text-sm leading-snug",
          muted ? "text-muted-foreground" : "text-foreground",
          className
        )}
      >
        {label}
      </dt>
      <dd className="text-right text-muted-foreground text-xs tabular-nums">
        {share}
      </dd>
      <dd className="text-right text-foreground text-sm tabular-nums">
        {value}
      </dd>
    </>
  );
}

/**
 * The list wrapper for {@link MetricCardLane} rows, and the owner of the shared
 * column tracks. Label takes the remaining width and wraps; share and figure
 * size to the widest content across every lane, so neither can be clipped by a
 * width guessed ahead of time.
 */
export function MetricCardLaneList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 gap-y-2",
        className
      )}
    >
      {children}
    </dl>
  );
}
