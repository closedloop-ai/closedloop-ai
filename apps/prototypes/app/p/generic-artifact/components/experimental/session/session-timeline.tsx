"use client";

// Prototype-local session presentation pending a separate Sessions review.

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import type {
  SessionDetail,
  TimelineMarker,
  TimelineMarkerKind,
} from "./mock-detail";
import {
  buildSessionActorEntries,
  type SessionActorEntry,
  sessionActorId,
} from "./session-actor-colors";
import {
  bucketCost,
  CostBarCell,
  clockLabel,
  DOT_GROUP_ORDER,
  type DotGroup,
  MarkerGroupDot,
  type SessionTimelineGrouping,
  type TimelineBucket,
} from "./session-timeline-cells";
import {
  continuousTimelineWindowStart,
  defaultTimelineScale,
  SCALE_MINUTES,
  TimelineScale,
  type TimelineScale as TimelineScaleType,
} from "./timeline-model";

export type { SessionTimelineGrouping } from "./session-timeline-cells";

const MAX_VISIBLE_BARS = 24;
const RENDERED_BARS = MAX_VISIBLE_BARS + 1;
const SECTION_TITLE_CLASS = "font-semibold text-foreground text-sm";
type ActivityPhase =
  | "Planning"
  | "Research"
  | "Implementation"
  | "Verification";
export type TimelineJumpBehavior = "instant" | "smooth";
export type TimelineJumpHandler = (
  row: number,
  atMinutes?: number,
  behavior?: TimelineJumpBehavior
) => void;

const SCALE_OPTIONS = Object.values(TimelineScale);
const STACK_GROUPINGS: readonly {
  value: SessionTimelineGrouping;
  label: string;
}[] = [
  { value: "token-type", label: "Token Type" },
  { value: "model", label: "Model" },
  { value: "activity-phase", label: "Activity phase" },
  { value: "actor", label: "Actor" },
];
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function formatMoney(value: number): string {
  return `$${value < 0.01 ? "0.00" : value.toFixed(2)}`;
}

function axisLabel(
  totalMinutes: number,
  includeDay: boolean,
  startDate?: string
): string {
  const dateMatch = startDate?.match(ISO_DATE_PATTERN);
  if (dateMatch && includeDay) {
    const date = new Date(
      Date.UTC(
        Number(dateMatch[1]),
        Number(dateMatch[2]) - 1,
        Number(dateMatch[3]) + Math.floor(totalMinutes / 1440)
      )
    );
    const dateLabel = `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}`;
    return `${dateLabel} ${clockLabel(totalMinutes)}`;
  }
  const day = Math.floor(totalMinutes / 1440) + 1;
  return includeDay
    ? `Day ${day} · ${clockLabel(totalMinutes)}`
    : clockLabel(totalMinutes);
}

function elapsedMinutes(label: string): number {
  const [hours, minutes] = label.split(":");
  return Number(hours) * 60 + Number(minutes);
}

type TracePoint = { atMinutes: number; row: number };

function visibleBucketIndex(
  atMinutes: number,
  sessionStartOffsetMinutes: number,
  scaleMinutes: number,
  renderWindowStart: number
): number {
  const timelineMinutes = sessionStartOffsetMinutes + atMinutes;
  return Math.floor(timelineMinutes / scaleMinutes) - renderWindowStart;
}

function createTimelineBuckets({
  detail,
  renderWindowStart,
  scale,
  scaleMinutes,
  sessionStartOffsetMinutes,
  timelineOriginMinutes,
}: {
  detail: SessionDetail;
  renderWindowStart: number;
  scale: TimelineScaleType;
  scaleMinutes: number;
  sessionStartOffsetMinutes: number;
  timelineOriginMinutes: number;
}): TimelineBucket[] {
  return Array.from({ length: RENDERED_BARS }, (_, visibleIndex) => {
    const absoluteIndex = renderWindowStart + visibleIndex;
    const bucketStart = absoluteIndex * scaleMinutes;
    const relativeBucketStart = bucketStart - sessionStartOffsetMinutes;
    return {
      key: `${scale}-${timelineOriginMinutes + bucketStart}`,
      label: `${clockLabel(
        timelineOriginMinutes + bucketStart
      )}–${clockLabel(timelineOriginMinutes + bucketStart + scaleMinutes)}`,
      atMinutes: Math.max(
        0,
        Math.min(
          detail.durationMinutes,
          bucketStart - sessionStartOffsetMinutes + scaleMinutes / 2
        )
      ),
      startMinutes: Math.max(
        0,
        Math.min(detail.durationMinutes, relativeBucketStart)
      ),
      endMinutes: Math.max(
        0,
        Math.min(detail.durationMinutes, relativeBucketStart + scaleMinutes)
      ),
      cIn: 0,
      cOut: 0,
      cCache: 0,
      total: 0,
      toolStart: 0,
      traceRow: null,
      byModel: {},
      byPhase: {},
      byActor: {},
    };
  });
}

function addCostsToBuckets({
  buckets,
  detail,
  renderWindowStart,
  scaleMinutes,
  sessionStartOffsetMinutes,
}: {
  buckets: TimelineBucket[];
  detail: SessionDetail;
  renderWindowStart: number;
  scaleMinutes: number;
  sessionStartOffsetMinutes: number;
}) {
  for (const event of detail.costEvents) {
    const bucket =
      buckets[
        visibleBucketIndex(
          event.atMinutes,
          sessionStartOffsetMinutes,
          scaleMinutes,
          renderWindowStart
        )
      ];
    if (!bucket) {
      continue;
    }
    bucket.cIn += event.cIn;
    bucket.cOut += event.cOut;
    bucket.cCache += event.cCache;
    const model = bucket.byModel[event.model] ?? {
      cIn: 0,
      cOut: 0,
      cCache: 0,
    };
    model.cIn += event.cIn;
    model.cOut += event.cOut;
    model.cCache += event.cCache;
    bucket.byModel[event.model] = model;
    bucket.byPhase[event.phase] =
      (bucket.byPhase[event.phase] ?? 0) +
      event.cIn +
      event.cOut +
      event.cCache;
    const actorId = sessionActorId(
      event.actorId,
      event.actorName,
      detail.ownerName
    );
    bucket.byActor[actorId] =
      (bucket.byActor[actorId] ?? 0) + event.cIn + event.cOut + event.cCache;
  }
}

function addTraceToBuckets({
  buckets,
  detail,
  renderWindowStart,
  scaleMinutes,
  sessionStartOffsetMinutes,
}: {
  buckets: TimelineBucket[];
  detail: SessionDetail;
  renderWindowStart: number;
  scaleMinutes: number;
  sessionStartOffsetMinutes: number;
}): TracePoint[] {
  const tracePoints = detail.trace.map((turn, index) => ({
    atMinutes: elapsedMinutes(turn.timeLabel),
    row: turn.row ?? index,
  }));
  for (const [index, turn] of detail.trace.entries()) {
    const turnMinutes = elapsedMinutes(turn.timeLabel);
    const bucket =
      buckets[
        visibleBucketIndex(
          turnMinutes,
          sessionStartOffsetMinutes,
          scaleMinutes,
          renderWindowStart
        )
      ];
    if (!bucket) {
      continue;
    }
    bucket.total += 1;
    bucket.toolStart += turn.blocks.filter(
      (block) => block.type === "tools"
    ).length;
    if (bucket.traceRow == null) {
      bucket.traceRow = turn.row ?? index;
      bucket.atMinutes = turnMinutes;
    }
  }
  return tracePoints;
}

function nearestTracePoint(
  tracePoints: readonly TracePoint[],
  atMinutes: number
): TracePoint | undefined {
  return tracePoints.reduce<TracePoint | undefined>((resolved, point) => {
    if (!resolved) {
      return point;
    }
    return Math.abs(point.atMinutes - atMinutes) <
      Math.abs(resolved.atMinutes - atMinutes)
      ? point
      : resolved;
  }, undefined);
}

function linkCostBucketsToTrace({
  buckets,
  renderWindowStart,
  scaleMinutes,
  sessionStartOffsetMinutes,
  tracePoints,
}: {
  buckets: TimelineBucket[];
  renderWindowStart: number;
  scaleMinutes: number;
  sessionStartOffsetMinutes: number;
  tracePoints: readonly TracePoint[];
}) {
  for (const [visibleIndex, bucket] of buckets.entries()) {
    if (bucketCost(bucket) <= 0 || bucket.traceRow != null) {
      continue;
    }
    const absoluteIndex = renderWindowStart + visibleIndex;
    const bucketMidpoint =
      absoluteIndex * scaleMinutes -
      sessionStartOffsetMinutes +
      scaleMinutes / 2;
    const nearest = nearestTracePoint(tracePoints, bucketMidpoint);
    bucket.traceRow = nearest?.row ?? null;
    if (nearest) {
      bucket.atMinutes = nearest.atMinutes;
    }
  }
}

function buildTimelineBuckets(args: {
  detail: SessionDetail;
  renderWindowStart: number;
  scale: TimelineScaleType;
  scaleMinutes: number;
  sessionStartOffsetMinutes: number;
  timelineOriginMinutes: number;
}): TimelineBucket[] {
  const buckets = createTimelineBuckets(args);
  addCostsToBuckets({ ...args, buckets });
  const tracePoints = addTraceToBuckets({ ...args, buckets });
  linkCostBucketsToTrace({ ...args, buckets, tracePoints });
  return buckets;
}

function markerGroup(kind: TimelineMarkerKind): DotGroup {
  if (kind === "commit" || kind === "pr") {
    return "delivery";
  }
  if (kind === "prompt") {
    return "human";
  }
  return "problem";
}

function groupingLabel(grouping: SessionTimelineGrouping): string {
  return (
    STACK_GROUPINGS.find((option) => option.value === grouping)?.label ??
    "Group"
  );
}

function groupingLegend(
  detail: SessionDetail,
  grouping: SessionTimelineGrouping,
  modelColors: ReadonlyMap<string, string>,
  actorEntries: readonly SessionActorEntry[]
): Array<{ color: string; key: string; label: string }> {
  if (grouping === "token-type") {
    return [
      { color: "var(--chart-3)", key: "cache", label: "Cache" },
      { color: "var(--chart-2)", key: "output", label: "Output" },
      { color: "var(--chart-1)", key: "input", label: "Input" },
    ];
  }
  if (grouping === "model") {
    return [...modelColors].map(([model, color]) => ({
      color,
      key: model,
      label: model,
    }));
  }
  if (grouping === "activity-phase") {
    const phaseColors: Record<ActivityPhase, string> = {
      Planning: "var(--chart-4)",
      Research: "var(--chart-2)",
      Implementation: "var(--chart-1)",
      Verification: "var(--chart-3)",
    };
    const activePhases = new Set(detail.costEvents.map((event) => event.phase));
    return Object.entries(phaseColors).flatMap(([phase, color]) =>
      activePhases.has(phase as ActivityPhase)
        ? [{ color, key: phase, label: phase }]
        : []
    );
  }
  return actorEntries.map((actor) => ({
    color: actor.colors.base,
    key: actor.id,
    label: actor.name,
  }));
}

export function SessionTimeline({
  detail,
  activeMinutes,
  defaultGrouping = "token-type",
  onJump,
  title = "Session Costs Over Time",
}: {
  detail: SessionDetail;
  activeMinutes: number;
  defaultGrouping?: SessionTimelineGrouping;
  onJump: TimelineJumpHandler;
  title?: string;
}) {
  const [scale, setScale] = useState<TimelineScaleType>(() =>
    defaultTimelineScale(detail.durationMinutes)
  );
  const [stackGrouping, setStackGrouping] =
    useState<SessionTimelineGrouping>(defaultGrouping);
  const [chartNavigation, setChartNavigation] = useState<{
    cursorPercent: number | null;
    settled: boolean;
    targetMinutes: number;
    windowStart: number;
  } | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const wheelMinutesRef = useRef(activeMinutes);
  const scaleMinutes = SCALE_MINUTES[scale];
  const modelColors = useMemo(
    () =>
      new Map(
        [...new Set(detail.costEvents.map((event) => event.model))]
          .sort()
          .map((model, index) => [model, `var(--chart-${(index % 5) + 1})`])
      ),
    [detail.costEvents]
  );
  const actorEntries = useMemo(
    () => buildSessionActorEntries(detail),
    [detail]
  );
  const legend = useMemo(
    () => groupingLegend(detail, stackGrouping, modelColors, actorEntries),
    [actorEntries, detail, modelColors, stackGrouping]
  );
  const tracePoints = useMemo(
    () =>
      detail.trace.map((turn, index) => ({
        atMinutes: elapsedMinutes(turn.timeLabel),
        row: turn.row ?? index,
      })),
    [detail.trace]
  );
  const timelineOriginMinutes =
    Math.floor(detail.timelineStartMinutes / scaleMinutes) * scaleMinutes;
  const sessionStartOffsetMinutes =
    detail.timelineStartMinutes - timelineOriginMinutes;
  const timelineSpanMinutes =
    sessionStartOffsetMinutes + detail.durationMinutes;
  const totalBars = Math.max(1, Math.ceil(timelineSpanMinutes / scaleMinutes));
  // The chart always presents a stable 24-column clock window. Sessions that
  // occupy fewer buckets leave the remaining columns empty; longer sessions
  // use the scrubber to move that same 24-column window through time.
  const visibleBars = MAX_VISIBLE_BARS;
  const maxWindowStart = Math.max(0, totalBars - visibleBars);
  const playbackWindowStart = continuousTimelineWindowStart(
    Math.min(detail.durationMinutes, activeMinutes),
    sessionStartOffsetMinutes,
    scaleMinutes,
    totalBars,
    MAX_VISIBLE_BARS
  );
  // Direct chart navigation is target-state UI: keep the plotted clock window
  // fixed and snap only the blue cursor to the exact clicked minute. The
  // scrubber and transcript remain playback-state UI and catch up smoothly.
  const continuousWindowStart =
    chartNavigation?.windowStart ?? playbackWindowStart;
  const renderWindowStart = Math.floor(continuousWindowStart);
  const fractionalWindowOffset = continuousWindowStart - renderWindowStart;
  const visibleStartMinutes = continuousWindowStart * scaleMinutes;
  const visibleEndMinutes = visibleStartMinutes + visibleBars * scaleMinutes;
  const sessionStartMinutes = detail.timelineStartMinutes;
  const sessionEndMinutes = sessionStartMinutes + detail.durationMinutes;
  const sessionSpansCalendarDays =
    Math.floor(sessionStartMinutes / 1440) !==
    Math.floor(sessionEndMinutes / 1440);
  const showDayContext =
    sessionSpansCalendarDays || visibleEndMinutes - visibleStartMinutes >= 1440;
  const stripStyle = {
    transform: `translate3d(-${(fractionalWindowOffset / RENDERED_BARS) * 100}%, 0, 0)`,
    width: `${(RENDERED_BARS / MAX_VISIBLE_BARS) * 100}%`,
  };

  const buckets = useMemo(
    () =>
      buildTimelineBuckets({
        detail,
        renderWindowStart,
        scale,
        scaleMinutes,
        sessionStartOffsetMinutes,
        timelineOriginMinutes,
      }),
    [
      detail,
      renderWindowStart,
      scale,
      scaleMinutes,
      sessionStartOffsetMinutes,
      timelineOriginMinutes,
    ]
  );

  const markerCells = useMemo(() => {
    const cells = buckets.map((bucket) => ({
      key: bucket.key,
      human: [] as TimelineMarker[],
      delivery: [] as TimelineMarker[],
      problem: [] as TimelineMarker[],
    }));
    for (const marker of detail.timelineMarkers) {
      const timelineMinutes = sessionStartOffsetMinutes + marker.atMinutes;
      const index =
        Math.floor(timelineMinutes / scaleMinutes) - renderWindowStart;
      const cell = cells[index];
      if (cell) {
        cell[markerGroup(marker.kind)].push(marker);
      }
    }
    return cells;
  }, [
    detail.timelineMarkers,
    renderWindowStart,
    scaleMinutes,
    sessionStartOffsetMinutes,
    buckets,
  ]);

  const peakCost = useMemo(() => {
    const totals = new Map<number, number>();
    for (const event of detail.costEvents) {
      const index = Math.floor(
        (sessionStartOffsetMinutes + event.atMinutes) / scaleMinutes
      );
      totals.set(
        index,
        (totals.get(index) ?? 0) + event.cIn + event.cOut + event.cCache
      );
    }
    return Math.max(0, ...totals.values());
  }, [detail.costEvents, scaleMinutes, sessionStartOffsetMinutes]);
  const maxCost = Math.max(0.01, peakCost);
  const cursorMinutes = chartNavigation?.targetMinutes ?? activeMinutes;
  const cursorAbsolutePosition =
    (sessionStartOffsetMinutes +
      Math.max(0, Math.min(detail.durationMinutes, cursorMinutes))) /
    scaleMinutes;
  const activeBucketIndex = cursorAbsolutePosition - continuousWindowStart;

  useEffect(() => {
    wheelMinutesRef.current = activeMinutes;
  }, [activeMinutes]);

  useEffect(() => {
    if (!chartNavigation) {
      return;
    }
    const distance = Math.abs(activeMinutes - chartNavigation.targetMinutes);
    if (!chartNavigation.settled && distance <= 0.5) {
      setChartNavigation((current) =>
        current ? { ...current, settled: true } : current
      );
      return;
    }
    // Once the animated navigation has converged, a subsequent scrubber or
    // transcript movement releases the pinned chart window back to playback.
    if (chartNavigation.settled && distance > 1) {
      setChartNavigation(null);
    }
  }, [activeMinutes, chartNavigation]);

  const beginChartNavigation = (atMinutes: number, clientX?: number) => {
    const targetMinutes = Math.max(
      0,
      Math.min(detail.durationMinutes, atMinutes)
    );
    const plotBounds = plotRef.current?.getBoundingClientRect();
    const cursorPercent =
      clientX == null || !plotBounds || plotBounds.width <= 0
        ? null
        : Math.max(
            0,
            Math.min(
              100,
              ((clientX - plotBounds.left) / plotBounds.width) * 100
            )
          );
    setChartNavigation({
      cursorPercent,
      settled: false,
      targetMinutes,
      windowStart: continuousWindowStart,
    });
    return targetMinutes;
  };

  const jumpToTimelineMinutes = (atMinutes: number, clientX: number) => {
    const targetMinutes = beginChartNavigation(atMinutes, clientX);
    const nearest = nearestTracePoint(tracePoints, targetMinutes);
    if (nearest) {
      onJump(nearest.row, targetMinutes);
    }
  };

  const jumpToMarker: TimelineJumpHandler = (row, atMinutes, behavior) => {
    const targetMinutes =
      atMinutes == null ? undefined : beginChartNavigation(atMinutes);
    onJump(row, targetMinutes, behavior);
  };

  const changeScale = (next: string) => {
    if (!next) {
      return;
    }
    setChartNavigation(null);
    setScale(next as TimelineScaleType);
  };

  const handleTimelineWheel = useCallback(
    (event: WheelEvent) => {
      const horizontalDelta =
        event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)
          ? event.deltaY
          : event.deltaX;
      const isHorizontalGesture =
        event.shiftKey || Math.abs(horizontalDelta) > Math.abs(event.deltaY);
      if (!(isHorizontalGesture && horizontalDelta !== 0)) {
        return;
      }
      const plotWidth = plotRef.current?.clientWidth ?? 0;
      if (plotWidth <= 0) {
        return;
      }
      event.preventDefault();
      let pixelDelta = horizontalDelta;
      if (event.deltaMode === 1) {
        pixelDelta *= 16;
      } else if (event.deltaMode === 2) {
        pixelDelta *= plotWidth;
      }
      const visibleMinutes = visibleBars * scaleMinutes;
      const targetMinutes = Math.max(
        0,
        Math.min(
          detail.durationMinutes,
          wheelMinutesRef.current + (pixelDelta / plotWidth) * visibleMinutes
        )
      );
      if (targetMinutes === wheelMinutesRef.current) {
        return;
      }
      wheelMinutesRef.current = targetMinutes;
      setChartNavigation(null);
      const nearest = nearestTracePoint(tracePoints, targetMinutes);
      if (nearest) {
        onJump(nearest.row, targetMinutes, "instant");
      }
    },
    [detail.durationMinutes, onJump, scaleMinutes, tracePoints]
  );

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) {
      return;
    }
    plot.addEventListener("wheel", handleTimelineWheel, { passive: false });
    return () => plot.removeEventListener("wheel", handleTimelineWheel);
  }, [handleTimelineWheel]);

  return (
    <section aria-labelledby="session-timeline-heading">
      <div className="mb-2.5 flex min-w-0 flex-wrap items-start gap-x-4 gap-y-1.5">
        <h2 className={SECTION_TITLE_CLASS} id="session-timeline-heading">
          {title}
        </h2>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 text-muted-foreground text-xs">
          <span className="whitespace-nowrap">
            <b className="text-foreground tabular-nums">{detail.costLabel}</b>{" "}
            cost
          </span>
          <Tooltip delayDuration={250}>
            <TooltipTrigger asChild>
              <button
                className="cursor-help whitespace-nowrap bg-transparent p-0 text-inherit"
                type="button"
              >
                Peak {scale} bucket{" "}
                <b className="text-foreground tabular-nums">
                  {formatMoney(peakCost)}
                </b>
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-64 [&>svg]:hidden">
              Highest-cost {scale} interval across the full session. This scale
              stays fixed while you scroll.
            </TooltipContent>
          </Tooltip>
          <span className="whitespace-nowrap">
            <b className="text-foreground tabular-nums">{detail.tokensLabel}</b>
          </span>
          <span className="whitespace-nowrap font-semibold text-foreground">
            {detail.durationLabel}
          </span>
        </div>
      </div>

      <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <ToggleGroup
          aria-label="Timeline scale"
          onValueChange={changeScale}
          type="single"
          value={scale}
          variant="outline"
        >
          {SCALE_OPTIONS.map((option) => (
            <ToggleGroupItem
              aria-label={`${option} timeline scale`}
              className="px-2.5 data-[variant=outline]:h-[26px]"
              key={option}
              value={option}
            >
              {option}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="ml-auto flex items-center gap-2">
          <span className="whitespace-nowrap text-muted-foreground text-xs">
            Group by
          </span>
          <Select
            onValueChange={(value) =>
              setStackGrouping(value as SessionTimelineGrouping)
            }
            value={stackGrouping}
          >
            <SelectTrigger
              aria-label="Group stacked bars by"
              className="h-[26px] w-[156px]"
              size="sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {STACK_GROUPINGS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <ul
        aria-label={`${groupingLabel(stackGrouping)} legend`}
        className="mb-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs"
      >
        {legend.map((entry) => (
          <li
            className="inline-flex min-w-0 items-center gap-1.5"
            key={entry.key}
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-[2px]"
              style={{ background: entry.color }}
            />
            <span className="truncate">{entry.label}</span>
          </li>
        ))}
      </ul>

      <div className="relative overscroll-x-contain pt-1.5" ref={plotRef}>
        <div className="relative overflow-hidden border-b">
          {activeBucketIndex < 0 ||
          activeBucketIndex > MAX_VISIBLE_BARS ? null : (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 z-10 border-primary border-l-2"
              style={{
                left: `${
                  chartNavigation?.cursorPercent ??
                  (activeBucketIndex / MAX_VISIBLE_BARS) * 100
                }%`,
              }}
            />
          )}
          <div
            className="grid h-[78px] items-end gap-0.5"
            style={{
              ...stripStyle,
              gridTemplateColumns: `repeat(${RENDERED_BARS}, minmax(0, 1fr))`,
            }}
          >
            {buckets.map((bucket) => (
              <CostBarCell
                actorEntries={actorEntries}
                bucket={bucket}
                grouping={stackGrouping}
                key={bucket.key}
                maxCost={maxCost}
                modelColors={modelColors}
                onJumpAtMinutes={jumpToTimelineMinutes}
              />
            ))}
          </div>
        </div>

        <div className="mt-1 overflow-hidden">
          <div
            className="grid h-[30px] gap-0.5"
            style={{
              ...stripStyle,
              gridTemplateColumns: `repeat(${RENDERED_BARS}, minmax(0, 1fr))`,
            }}
          >
            {markerCells.map((cell) => (
              <div
                className="flex min-w-0 flex-col items-center"
                key={`markers-${cell.key}`}
              >
                {DOT_GROUP_ORDER.map((group) => {
                  const events = cell[group];
                  return events.length > 0 ? (
                    <MarkerGroupDot
                      events={events}
                      group={group}
                      key={group}
                      onJump={jumpToMarker}
                      timelineStartMinutes={detail.timelineStartMinutes}
                    />
                  ) : (
                    <span aria-hidden className="h-[10px]" key={group} />
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="mt-1.5 flex justify-between text-muted-foreground text-xs tabular-nums">
          <span>
            {axisLabel(
              timelineOriginMinutes + visibleStartMinutes,
              showDayContext,
              detail.timelineStartDate
            )}
          </span>
          <span>
            {axisLabel(
              timelineOriginMinutes + visibleEndMinutes,
              showDayContext,
              detail.timelineStartDate
            )}
          </span>
        </div>
      </div>

      {maxWindowStart > 0 ? (
        <div className="mt-3 flex items-center">
          <input
            aria-label="Session time position"
            className="h-1.5 w-full cursor-ew-resize"
            max={Math.max(1, Math.round(detail.durationMinutes))}
            min={0}
            onChange={(event) => {
              setChartNavigation(null);
              const atMinutes = Number(event.target.value);
              const nearest = detail.trace.reduce<{
                row: number;
                distance: number;
              }>(
                (resolved, turn, index) => {
                  const distance = Math.abs(
                    elapsedMinutes(turn.timeLabel) - atMinutes
                  );
                  return distance < resolved.distance
                    ? { row: turn.row ?? index, distance }
                    : resolved;
                },
                { row: 0, distance: Number.POSITIVE_INFINITY }
              );
              onJump(nearest.row, atMinutes, "instant");
            }}
            step={1}
            style={{
              accentColor:
                "color-mix(in oklab, var(--muted-foreground) 70%, var(--background))",
            }}
            type="range"
            value={Math.min(
              Math.round(detail.durationMinutes),
              Math.round(activeMinutes)
            )}
          />
        </div>
      ) : null}
    </section>
  );
}
