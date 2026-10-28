"use client";

import type { BranchCommit } from "@repo/api/src/types/branch";
import type { BranchAssociatedPullRequest } from "@repo/api/src/types/branch-associated-pull-request";
import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import {
  resolveTimelineColumnIndex,
  type TimelineScale as TimelineScaleType,
  timelineColumnStartMs,
} from "@repo/app/agents/lib/session-timeline-scale";
import {
  TimelineMarkerRail,
  TimelineMarkerStaticTarget,
  TimelineMarkerTrigger,
} from "@repo/app/shared/components/timeline-marker-rail";
import {
  getBranchTimelineMarkerGeometry,
  getPackedTimelineMarkerStyle,
  type PackedTimelineCluster,
  type PackedTimelineMarker,
  type TimelineMarkerInput,
} from "@repo/app/shared/lib/timeline-marker-packing";
import {
  getTimelineMarkerSemanticToken,
  TimelineMarkerSemantic,
  type TimelineMarkerSemantic as TimelineMarkerSemanticType,
} from "@repo/app/shared/lib/timeline-marker-semantics";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
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
 * hours when the parent supplies them, and packed by rendered hit-target
 * collision so non-overlapping events reuse lanes while dense collisions form
 * accessible clusters. Hovering or focusing a dot opens the design's
 * `bq-tip-mk` card; clicking it scrubs the shared playhead to the dot's
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
  /**
   * The canonical grid `activeHourStarts` were cut on (ISS-8771). The rail used
   * to take a column WIDTH and re-floor each dot with `Math.floor(t / columnMs)`
   * — a third copy of the grid, on the epoch rather than the viewer's clock. It
   * agreed with the bars only while the bars were on that same wrong grid; once
   * they moved, every trace dot string-compared against a column key that could
   * not exist and silently vanished. Asking the one grid removes the class.
   *
   * Absent, no dot is filtered or column-aligned — the caller has not stated a
   * grid, so the rail must not invent one.
   */
  activeColumnGrid?: { originMs: number; scale: TimelineScaleType };
  /** Render markers at timeline column centers rather than exact in-column time. */
  alignToTimelineColumns?: boolean;
  /** Shared axis (from E1) so dots align with the bars; else derived from dots. */
  range?: TimeRange | null;
  activeRow?: number | null;
  /** Scrub the shared playhead to a dot's timestamp (scrolls the trace). */
  onScrub?: (t: string) => void;
  /** Jump to the exact trace row for trace-backed dots. */
  onScrubRow?: (row: number, flash?: boolean) => void;
  className?: string;
};

type TimelineEventColor = "blue" | "green" | "red";

type TimelineEventDot = {
  filterToActiveHour: boolean;
  row: number | null;
  source: "lifecycle" | "trace";
  t: string;
  color: TimelineEventColor;
  label: string;
};

type BranchTimelineMarkerPayload = {
  dot: TimelineEventDot;
};

const COLOR_CLASS: Record<TimelineEventColor, string> = {
  blue: "d-blue",
  green: "d-green",
  red: "d-red",
};

const COLOR_SEMANTIC: Record<TimelineEventColor, TimelineMarkerSemanticType> = {
  blue: TimelineMarkerSemantic.HumanSteering,
  green: TimelineMarkerSemantic.Delivery,
  red: TimelineMarkerSemantic.FailureLimit,
};

/** Category header (label + accent color) for the marker tooltip. */
const DOT_META: Record<TimelineEventColor, { label: string; color: string }> = {
  blue: {
    label: "Human steering",
    color: getTimelineMarkerSemanticToken(TimelineMarkerSemantic.HumanSteering),
  },
  green: { label: "Commits & PRs", color: "var(--success-foreground)" },
  red: {
    label: "Failures & limits",
    color: getTimelineMarkerSemanticToken(TimelineMarkerSemantic.FailureLimit),
  },
};

const BRANCH_MARKER_GEOMETRY = getBranchTimelineMarkerGeometry();

function EventDot({
  marker,
  active,
  onScrub,
  onScrubRow,
}: {
  marker: PackedTimelineMarker<BranchTimelineMarkerPayload>;
  active: boolean;
  onScrub?: (t: string) => void;
  onScrubRow?: (row: number, flash?: boolean) => void;
}) {
  const dot = marker.item.payload.dot;
  const className = cn(COLOR_CLASS[dot.color], active && "hot");
  const style = getPackedTimelineMarkerStyle(marker);
  if (!(onScrub || onScrubRow)) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <TimelineMarkerStaticTarget
            className="bq-marker-trigger bq-marker-static"
            style={style}
          >
            <EventDotGlyph className={className} color={dot.color} />
          </TimelineMarkerStaticTarget>
        </TooltipTrigger>
        <DotTooltipContent dot={dot} />
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <TimelineMarkerTrigger
          ariaLabel={dot.label}
          className={cn("bq-marker-trigger", active && "hot")}
          onClick={() => jumpToDot(dot, onScrub, onScrubRow)}
          style={style}
        >
          <EventDotGlyph className={className} color={dot.color} />
        </TimelineMarkerTrigger>
      </TooltipTrigger>
      <DotTooltipContent dot={dot} />
    </Tooltip>
  );
}

function EventCluster({
  cluster,
  active,
  onScrub,
  onScrubRow,
}: {
  cluster: PackedTimelineCluster<BranchTimelineMarkerPayload>;
  active: boolean;
  onScrub?: (t: string) => void;
  onScrubRow?: (row: number, flash?: boolean) => void;
}) {
  const dots = cluster.items.map((item) => item.payload.dot);
  const style = getPackedTimelineMarkerStyle(cluster);
  const label = `${dots.length} more timeline events near ${formatClock(
    cluster.items[0]?.timeMs ?? 0
  )}`;
  if (!(onScrub || onScrubRow)) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <TimelineMarkerStaticTarget
            className="bq-marker-trigger bq-marker-static"
            style={style}
          >
            <EventClusterGlyph active={active} dots={dots} />
          </TimelineMarkerStaticTarget>
        </TooltipTrigger>
        <DotClusterTooltipContent dots={dots} />
      </Tooltip>
    );
  }
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <TimelineMarkerTrigger
              ariaLabel={label}
              className={cn("bq-marker-trigger", active && "hot")}
              style={style}
            >
              <EventClusterGlyph active={active} dots={dots} />
            </TimelineMarkerTrigger>
          </PopoverTrigger>
        </TooltipTrigger>
        <DotClusterTooltipContent dots={dots} />
      </Tooltip>
      <DotClusterTipContent
        dots={dots}
        onScrub={onScrub}
        onScrubRow={onScrubRow}
      />
    </Popover>
  );
}

function EventDotGlyph({
  className,
  color,
}: {
  className: string;
  color: TimelineEventColor;
}) {
  return (
    <span
      className={cn("bq-dot", className)}
      style={{ background: DOT_META[color].color }}
    />
  );
}

function EventClusterGlyph({
  active,
  dots,
}: {
  active: boolean;
  dots: readonly TimelineEventDot[];
}) {
  return (
    <span
      className={cn("bq-dot bq-dot-cluster", active && "hot")}
      style={{ background: getClusterBackground(dots) }}
    />
  );
}

function DotTooltipContent({ dot }: { dot: TimelineEventDot }) {
  const meta = DOT_META[dot.color];
  return (
    <TooltipContent
      className="bq-tip-mk max-h-[min(60vh,360px)] w-auto overflow-y-auto border-0 bg-popover p-3 text-popover-foreground shadow-xl [&>[data-radix-popper-arrow]]:hidden [&>svg]:hidden"
      collisionPadding={12}
      side="top"
      sideOffset={6}
    >
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
            <span className="bq-tip-lt">{getDotProvenanceLabel(dot)}</span>
          </div>
          <span className="bq-tip-ll">{dot.label}</span>
        </div>
      </div>
    </TooltipContent>
  );
}

function DotClusterTooltipContent({
  dots,
}: {
  dots: readonly TimelineEventDot[];
}) {
  const header = getClusterTooltipHeader(dots);
  return (
    <TooltipContent
      className="bq-tip-mk max-h-[min(60vh,360px)] w-auto overflow-y-auto border-0 bg-popover p-3 text-popover-foreground shadow-xl [&>[data-radix-popper-arrow]]:hidden [&>svg]:hidden"
      collisionPadding={12}
      side="top"
      sideOffset={6}
    >
      <div className="bq-tip-mkhead" style={{ color: header.color }}>
        <span className="bq-tip-sw" style={{ background: header.color }} />
        {header.label}
      </div>
      <div className="bq-tip-list">
        {dots.map((dot, index) => {
          const meta = DOT_META[dot.color];
          return (
            <div
              className="bq-tip-li"
              key={`${dot.t}-${dot.row ?? `l${index}`}-${dot.label}`}
            >
              <div className="bq-tip-litop">
                <span
                  className="bq-tip-sw"
                  style={{ background: meta.color }}
                />
                <span className="bq-tip-name">{meta.label}</span>
                <span className="bq-tip-lt font-mono">
                  {formatClock(Date.parse(dot.t))}
                </span>
              </div>
              <span className="bq-tip-ll">{dot.label}</span>
            </div>
          );
        })}
      </div>
    </TooltipContent>
  );
}

function DotClusterTipContent({
  dots,
  onScrub,
  onScrubRow,
}: {
  dots: readonly TimelineEventDot[];
  onScrub?: (t: string) => void;
  onScrubRow?: (row: number, flash?: boolean) => void;
}) {
  return (
    <PopoverContent
      align="center"
      className="bq-tip-mk max-h-[min(70vh,420px)] w-auto overflow-y-auto p-3"
      collisionPadding={12}
      side="top"
      sideOffset={8}
    >
      <div className="bq-tip-mkhead">
        <span className="bq-tip-sw bq-tip-cluster-sw" />
        Overflow events
      </div>
      <div className="bq-tip-list">
        {dots.map((dot, index) => {
          const meta = DOT_META[dot.color];
          return (
            <button
              aria-label={`Jump to ${dot.label}`}
              className="bq-tip-li bq-tip-action"
              key={`${dot.t}-${dot.row ?? `l${index}`}-${dot.label}`}
              onClick={() => jumpToDot(dot, onScrub, onScrubRow)}
              type="button"
            >
              <div className="bq-tip-litop">
                <span
                  className="bq-tip-sw"
                  style={{ background: meta.color }}
                />
                <span className="bq-tip-name">{meta.label}</span>
                <span className="bq-tip-lt font-mono">
                  {formatClock(Date.parse(dot.t))}
                </span>
                <span className="bq-tip-lt">{getDotProvenanceLabel(dot)}</span>
              </div>
              <span className="bq-tip-ll">{dot.label}</span>
            </button>
          );
        })}
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
  activeColumnGrid,
  alignToTimelineColumns = false,
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
    if (alignToTimelineColumns) {
      return columnAlignedRangeForDots(dots, activeHourSet, activeColumnGrid);
    }
    const stamps = dots
      .filter((dot) =>
        isDotInActiveColumn(dot, activeHourSet, activeColumnGrid)
      )
      .map((dot) => dot.t);
    return timeRange(stamps, stamps);
  }, [activeColumnGrid, activeHourSet, alignToTimelineColumns, range, dots]);

  const railItems = useMemo<
    TimelineMarkerInput<BranchTimelineMarkerPayload>[]
  >(() => {
    if (!axis) {
      return [];
    }
    return dots.flatMap((dot, i) => {
      const ms = Date.parse(dot.t);
      if (Number.isNaN(ms)) {
        return [];
      }
      if (!isDotInActiveColumn(dot, activeHourSet, activeColumnGrid)) {
        return [];
      }
      return [
        {
          id: getEventDotKey(dot, i),
          label: dot.label,
          leftPct: markerLeftPct({
            alignToColumn: alignToTimelineColumns,
            axis,
            grid: activeColumnGrid,
            timeMs: ms,
          }),
          payload: { dot },
          row: dot.row,
          semantic: COLOR_SEMANTIC[dot.color],
          sourceOrder: i,
          stableOrderKey: getEventDotStableOrderKey(dot, i),
          timeMs: ms,
        },
      ];
    });
  }, [activeColumnGrid, activeHourSet, alignToTimelineColumns, axis, dots]);

  if (railItems.length === 0) {
    return null;
  }

  return (
    <div className={cn("bq-drail-wrap", className)}>
      <TimelineMarkerRail
        className="bq-drail"
        geometry={BRANCH_MARKER_GEOMETRY}
        items={railItems}
        layout="packed"
        renderCluster={(cluster) => (
          <EventCluster
            active={
              activeRow != null &&
              cluster.items.some((item) => item.payload.dot.row === activeRow)
            }
            cluster={cluster}
            key={cluster.id}
            onScrub={onScrub}
            onScrubRow={onScrubRow}
          />
        )}
        renderMarker={(marker) => (
          <EventDot
            active={
              activeRow != null && marker.item.payload.dot.row === activeRow
            }
            key={marker.id}
            marker={marker}
            onScrub={onScrub}
            onScrubRow={onScrubRow}
          />
        )}
      />
    </div>
  );
});

function columnAlignedRangeForDots(
  dots: readonly TimelineEventDot[],
  activeColumnSet: ReadonlySet<string> | null,
  grid: TimelineColumnGrid | undefined
): TimeRange | null {
  if (!grid) {
    return null;
  }
  const columns = dots.flatMap((dot) => {
    if (!isDotInActiveColumn(dot, activeColumnSet, grid)) {
      return [];
    }
    const ms = Date.parse(dot.t);
    return Number.isNaN(ms) ? [] : [columnIndexOf(ms, grid)];
  });
  if (columns.length === 0) {
    return null;
  }
  // The LAST column's own end boundary, not `start + columnMs`: a `12h` column
  // holding a DST transition is 11 or 13 hours wide, so a multiplied end names
  // an instant the axis is not drawn to.
  const startMs = columnStartMs(Math.min(...columns), grid);
  const endMs = columnStartMs(Math.max(...columns) + 1, grid);
  return { endMs, spanMs: Math.max(1, endMs - startMs), startMs };
}

function isDotInActiveColumn(
  dot: TimelineEventDot,
  activeColumnSet: ReadonlySet<string> | null,
  grid: TimelineColumnGrid | undefined
): boolean {
  if (!(dot.filterToActiveHour && activeColumnSet && grid)) {
    return true;
  }
  const ms = Date.parse(dot.t);
  if (Number.isNaN(ms)) {
    return false;
  }
  return activeColumnSet.has(
    new Date(columnStartMs(columnIndexOf(ms, grid), grid)).toISOString()
  );
}

function markerLeftPct({
  alignToColumn,
  axis,
  grid,
  timeMs,
}: {
  alignToColumn: boolean;
  axis: TimeRange;
  grid: TimelineColumnGrid | undefined;
  timeMs: number;
}): number {
  const positionedMs =
    alignToColumn && grid ? columnMidpointMs(timeMs, grid) : timeMs;
  return (
    fractionOf(
      axis,
      Math.min(axis.endMs, Math.max(axis.startMs, positionedMs))
    ) * 100
  );
}

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
      source: "trace",
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
      source: "lifecycle",
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
      source: "lifecycle",
      t: input.openedAt,
    });
  }
  if (isValidInstant(input.mergedAt)) {
    dots.push({
      color: "green",
      filterToActiveHour: false,
      label: `Merged${suffix}`,
      row: null,
      source: "lifecycle",
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
      source: "lifecycle",
      t: pullRequest.openedAt,
    });
  }
  if (isValidInstant(pullRequest.mergedAt)) {
    dots.push({
      color: "green",
      filterToActiveHour: false,
      label: `Merged${suffix}`,
      row: null,
      source: "lifecycle",
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
      source: "lifecycle",
      t: pullRequest.closedAt,
    });
  }
}

function isValidInstant(value: string | null): value is string {
  return value != null && !Number.isNaN(Date.parse(value));
}

type TimelineColumnGrid = { originMs: number; scale: TimelineScaleType };

function columnIndexOf(instantMs: number, grid: TimelineColumnGrid): number {
  return resolveTimelineColumnIndex({
    instantMs,
    originMs: grid.originMs,
    scale: grid.scale,
  });
}

function columnStartMs(columnIndex: number, grid: TimelineColumnGrid): number {
  return timelineColumnStartMs({
    columnIndex,
    originMs: grid.originMs,
    scale: grid.scale,
  });
}

/** The centre of the column an instant falls in, measured off its real edges. */
function columnMidpointMs(instantMs: number, grid: TimelineColumnGrid): number {
  const column = columnIndexOf(instantMs, grid);
  const startMs = columnStartMs(column, grid);
  return startMs + (columnStartMs(column + 1, grid) - startMs) / 2;
}

function jumpToDot(
  dot: TimelineEventDot,
  onScrub: ((t: string) => void) | undefined,
  onScrubRow: ((row: number, flash?: boolean) => void) | undefined
): void {
  if (dot.row != null && onScrubRow) {
    onScrubRow(dot.row, true);
    return;
  }
  onScrub?.(dot.t);
}

function getEventDotKey(dot: TimelineEventDot, sourceOrder: number): string {
  return `${dot.color}-${dot.row ?? `l${sourceOrder}`}-${dot.t}-${dot.label}`;
}

function getEventDotStableOrderKey(
  dot: TimelineEventDot,
  sourceOrder: number
): string {
  return `${dot.source}:${dot.row ?? Number.MAX_SAFE_INTEGER}:${dot.label}:${sourceOrder}`;
}

function getDotProvenanceLabel(dot: TimelineEventDot): string {
  return dot.row == null ? "Lifecycle event" : `Trace row ${dot.row + 1}`;
}

function getClusterBackground(dots: readonly TimelineEventDot[]): string {
  const colors = Array.from(
    new Set(dots.map((dot) => DOT_META[dot.color].color))
  );
  if (colors.length <= 1) {
    return colors[0] ?? "var(--muted-foreground)";
  }
  return `conic-gradient(${colors.join(", ")}, ${colors[0]})`;
}

function getClusterTooltipHeader(dots: readonly TimelineEventDot[]): {
  label: string;
  color: string;
} {
  const first = dots[0];
  if (first && dots.every((dot) => dot.color === first.color)) {
    return DOT_META[first.color];
  }
  return { color: "var(--foreground)", label: "Timeline events" };
}
