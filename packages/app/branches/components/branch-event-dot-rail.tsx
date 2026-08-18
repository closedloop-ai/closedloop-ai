"use client";

import type { BranchCommit } from "@repo/api/src/types/branch";
import type { BranchAssociatedPullRequest } from "@repo/api/src/types/branch-associated-pull-request";
import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { cn } from "@repo/design-system/lib/utils";
import { memo, useMemo } from "react";
import {
  formatClock,
  fractionOf,
  type TimeRange,
  timeRange,
} from "../lib/branch-timeline-range";

/**
 * Event-dot rail for the exact Branch timeline event language: blue human
 * steering, green GitHub/pull-request lifecycle, and red failures or limits.
 * Dots are positioned by authoritative event time, filtered to active timeline
 * hours when the parent supplies them, and stacked within an hour so simultaneous
 * events remain separately clickable. Hovering or focusing a dot opens the
 * design's `bq-tip-mk` card; clicking it scrubs the shared playhead to the dot's
 * timestamp (`onScrub`), which scrolls the trace — the same path the bars and
 * playhead use — so lifecycle dots (no trace row, e.g. the merge) work too.
 */
export type BranchEventDotRailProps = {
  traceItems: readonly MergedTraceItem[];
  /** Merge timestamp (structured detail) → a green lifecycle "Merged" dot. */
  mergedAt?: string | null;
  /** PR opened timestamp (PRD-486) → a green "Opened" lifecycle dot. */
  openedAt?: string | null;
  /** Real commits on the branch (PRD-486) → one green dot each, by commit time. */
  commits?: readonly BranchCommit[];
  /** PR number, labels the lifecycle dots ("Merged #123"). */
  prNumber?: number | null;
  /** Complete associated PR history, including closed-unmerged outcomes. */
  pullRequests?: readonly BranchAssociatedPullRequest[];
  /** Live PR comment count (soft F3); null/undefined → no orange. */
  /** @deprecated PR comments belong in the tab-scoped comments rail. */
  prCommentCount?: number | null;
  /**
   * GitHub connection state. `true` → may show orange comments; `false` → shows
   * the connect hint; `undefined` (unknown — the v1 default) → shows neither.
   */
  /** @deprecated Connection state no longer changes timeline event semantics. */
  githubConnected?: boolean;
  /** Active bar hour starts. When present, dots outside those bars are omitted. */
  activeHourStarts?: readonly string[];
  /** Shared axis (from E1) so dots align with the bars; else derived from dots. */
  range?: TimeRange | null;
  activeRow?: number | null;
  /** Scrub the shared playhead to a dot's timestamp (scrolls the trace). */
  onScrub?: (t: string) => void;
  /** Jump to the exact trace row for trace-backed dots. */
  onScrubRow?: (row: number) => void;
  className?: string;
};

type TimelineEventColor = "blue" | "green" | "red";

type TimelineEventDot = {
  filterToActiveHour: boolean;
  row: number | null;
  t: string;
  color: TimelineEventColor;
  label: string;
};

const COLOR_CLASS: Record<TimelineEventColor, string> = {
  blue: "d-blue",
  green: "d-green",
  red: "d-red",
};

/** Category header (label + accent color) for the marker tooltip. */
const DOT_META: Record<TimelineEventColor, { label: string; color: string }> = {
  blue: { label: "Human steering", color: "var(--primary)" },
  green: { label: "Commits, PRs & merges", color: "var(--success-foreground)" },
  red: { label: "Failures & limits", color: "var(--destructive)" },
};

type PositionedDot = {
  dot: TimelineEventDot;
  key: string;
  left: number;
  stackIndex: number;
};

function EventDot({
  dot,
  left,
  stackIndex,
  active,
  onScrub,
  onScrubRow,
}: {
  dot: TimelineEventDot;
  left: number;
  stackIndex: number;
  active: boolean;
  onScrub?: (t: string) => void;
  onScrubRow?: (row: number) => void;
}) {
  const className = cn(COLOR_CLASS[dot.color], active && "hot");
  const style = {
    left: `${left}%`,
    top: `${3 + stackIndex * 34}px`,
  };
  // FEA-3866: the marker detail is a tap-triggered `Popover` on the dot, not a
  // mouse-position tooltip — no hover dependency, so it's reachable on touch.
  // Radix portals the content (clearing the sticky timeline's stacking context
  // and the page scroller's overflow like the old body portal did) and gives
  // focus management + Escape-to-close for free. Clicking the dot still scrubs
  // the playhead (`onScrub`) AND opens the tip — one tap does both. A dot with
  // no `onScrub` (no trace row to scrub to) stays a plain, non-interactive
  // marker, exactly as before.
  if (!(onScrub || onScrubRow)) {
    return <span className={cn("bq-dot", className)} style={style} />;
  }
  return (
    <Popover>
      <PopoverTrigger
        aria-label={dot.label}
        className="absolute flex size-8 -translate-x-1/2 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        onClick={() =>
          dot.row != null && onScrubRow ? onScrubRow(dot.row) : onScrub?.(dot.t)
        }
        style={style}
        type="button"
      >
        <span
          className={cn("bq-dot relative top-0 left-0", className)}
          style={{ background: DOT_META[dot.color].color }}
        />
      </PopoverTrigger>
      <DotTipContent dot={dot} />
    </Popover>
  );
}

/**
 * The marker detail rendered inside the dot's `Popover` (FEA-3866). Radix
 * portals it above the sticky chrome and owns the card shell (`bg-popover`,
 * border, radius, shadow, padding) from the `PopoverContent` primitive — so no
 * hand-rolled card chrome here. `bq-tip-mk` only carries the marker-card widths;
 * `w-auto p-3` overrides the primitive's fixed `w-72`/`p-4` so the compact tip
 * sizes to its content. The inner `bq-tip-*` classes style the header + list.
 */
function DotTipContent({ dot }: { dot: TimelineEventDot }) {
  const meta = DOT_META[dot.color];
  return (
    <PopoverContent align="center" className="bq-tip-mk w-auto p-3" side="top">
      <div className="bq-tip-mkhead" style={{ color: meta.color }}>
        <span className="bq-tip-sw" style={{ background: meta.color }} />
        {meta.label}
      </div>
      <div className="bq-tip-list">
        <div className="bq-tip-li">
          <div className="bq-tip-litop">
            <span className="bq-tip-lt font-mono">
              {formatClock(Date.parse(dot.t))}
            </span>
          </div>
          <span className="bq-tip-ll">{dot.label}</span>
        </div>
      </div>
    </PopoverContent>
  );
}

export const BranchEventDotRail = memo(function BranchEventDotRail({
  traceItems,
  mergedAt,
  openedAt,
  commits,
  prNumber,
  pullRequests,
  activeHourStarts,
  range,
  activeRow,
  onScrub,
  onScrubRow,
  className,
}: BranchEventDotRailProps) {
  const dots = useMemo(
    () => [
      ...deriveTraceEventDots(traceItems),
      ...deriveTimelineLifecycleDots({
        mergedAt: mergedAt ?? null,
        prNumber: prNumber ?? null,
        openedAt: openedAt ?? null,
        commits: commits ?? [],
        pullRequests: pullRequests ?? [],
      }),
    ],
    [traceItems, mergedAt, prNumber, openedAt, commits, pullRequests]
  );
  const activeHourSet = useMemo(
    () => (activeHourStarts ? new Set(activeHourStarts) : null),
    [activeHourStarts]
  );
  const axis = useMemo(() => {
    if (range) {
      return range;
    }
    const stamps = dots.map((dot) => dot.t);
    return timeRange(stamps, stamps);
  }, [range, dots]);

  const positioned = useMemo<PositionedDot[]>(() => {
    if (!axis) {
      return [];
    }
    const stackByHour = new Map<string, number>();
    const entries: PositionedDot[] = [];
    dots.forEach((dot, i) => {
      const ms = Date.parse(dot.t);
      if (Number.isNaN(ms)) {
        return;
      }
      const hourStart = floorTimelineHour(ms);
      if (
        dot.filterToActiveHour &&
        activeHourSet &&
        !activeHourSet.has(hourStart)
      ) {
        return;
      }
      const stackIndex = stackByHour.get(hourStart) ?? 0;
      stackByHour.set(hourStart, stackIndex + 1);
      entries.push({
        dot,
        left: fractionOf(axis, ms) * 100,
        // Lifecycle dots all have row: null, and N commit/PR dots can share a
        // color+timestamp; disambiguate with the array index so React never
        // drops a sibling. (`l${i}` can't collide with a numeric trace row.)
        key: `${dot.color}-${dot.row ?? `l${i}`}-${dot.t}`,
        stackIndex,
      });
    });
    return entries;
  }, [activeHourSet, axis, dots]);

  if (positioned.length === 0) {
    return null;
  }

  const stackCount = Math.max(
    1,
    ...positioned.map((entry) => entry.stackIndex + 1)
  );

  return (
    <div className={cn("bq-drail-wrap", className)}>
      {/* Each dot owns its own tap `Popover` (FEA-3866), so the rail no longer
          tracks a shared hovered marker or clears it on mouse-leave. */}
      <div className="bq-drail" style={{ height: `${4 + stackCount * 34}px` }}>
        {positioned.map((entry) => (
          <EventDot
            active={activeRow != null && entry.dot.row === activeRow}
            dot={entry.dot}
            key={entry.key}
            left={entry.left}
            onScrub={onScrub}
            onScrubRow={onScrubRow}
            stackIndex={entry.stackIndex}
          />
        ))}
      </div>
    </div>
  );
});

const TIMELINE_HOUR_MS = 3_600_000;

function deriveTraceEventDots(
  items: readonly MergedTraceItem[]
): TimelineEventDot[] {
  const dots: TimelineEventDot[] = [];
  items.forEach((item, row) => {
    if (item.type !== "event") {
      return;
    }
    const color = resolveTraceEventColor(item.dot);
    dots.push({
      color,
      filterToActiveHour: true,
      label: item.text,
      row,
      t: item.t,
    });
  });
  return dots;
}

function resolveTraceEventColor(dot: "g" | "b" | "r"): TimelineEventColor {
  const colorByDot = {
    b: "blue",
    g: "green",
    r: "red",
  } as const satisfies Record<typeof dot, TimelineEventColor>;
  return colorByDot[dot];
}

function deriveTimelineLifecycleDots(input: {
  mergedAt: string | null;
  prNumber: number | null;
  openedAt: string | null;
  commits: readonly BranchCommit[];
  pullRequests: readonly BranchAssociatedPullRequest[];
}): TimelineEventDot[] {
  const dots: TimelineEventDot[] = [];
  for (const commit of input.commits) {
    if (!isValidInstant(commit.committedAt)) {
      continue;
    }
    dots.push({
      color: "green",
      filterToActiveHour: false,
      label: commit.message || commit.sha.slice(0, 7),
      row: null,
      t: commit.committedAt,
    });
  }
  for (const pullRequest of input.pullRequests) {
    appendPullRequestLifecycleDots(dots, pullRequest);
  }
  if (input.pullRequests.length > 0) {
    return dots;
  }
  const suffix = input.prNumber == null ? "" : ` #${input.prNumber}`;
  if (isValidInstant(input.openedAt)) {
    dots.push({
      color: "green",
      filterToActiveHour: false,
      label: `Opened${suffix}`,
      row: null,
      t: input.openedAt,
    });
  }
  if (isValidInstant(input.mergedAt)) {
    dots.push({
      color: "green",
      filterToActiveHour: false,
      label: `Merged${suffix}`,
      row: null,
      t: input.mergedAt,
    });
  }
  return dots;
}

function appendPullRequestLifecycleDots(
  dots: TimelineEventDot[],
  pullRequest: BranchAssociatedPullRequest
): void {
  const suffix = ` #${pullRequest.number}`;
  if (isValidInstant(pullRequest.openedAt)) {
    dots.push({
      color: "green",
      filterToActiveHour: false,
      label: `Opened${suffix}`,
      row: null,
      t: pullRequest.openedAt,
    });
  }
  if (isValidInstant(pullRequest.mergedAt)) {
    dots.push({
      color: "green",
      filterToActiveHour: false,
      label: `Merged${suffix}`,
      row: null,
      t: pullRequest.mergedAt,
    });
    return;
  }
  if (isValidInstant(pullRequest.closedAt)) {
    dots.push({
      color: "green",
      filterToActiveHour: false,
      label: `Closed${suffix}`,
      row: null,
      t: pullRequest.closedAt,
    });
  }
}

function isValidInstant(value: string | null): value is string {
  return value != null && !Number.isNaN(Date.parse(value));
}

function floorTimelineHour(timestamp: number): string {
  return new Date(
    Math.floor(timestamp / TIMELINE_HOUR_MS) * TIMELINE_HOUR_MS
  ).toISOString();
}
