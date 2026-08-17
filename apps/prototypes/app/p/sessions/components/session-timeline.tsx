"use client";

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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { useEffect, useMemo, useState } from "react";
import type {
  SessionDetail,
  TimelineMarker,
  TimelineMarkerKind,
} from "../mock-detail";
import {
  defaultTimelineScale,
  SCALE_MINUTES,
  TimelineScale,
  type TimelineScale as TimelineScaleType,
  timelineBucketIndex,
  timelineWindowStart,
} from "../timeline-model";

const MAX_VISIBLE_BARS = 24;
const SECTION_TITLE_CLASS = "font-semibold text-foreground text-sm";
const COST_TOOLTIP_CLASS =
  "w-[260px] max-w-[calc(100vw-48px)] overflow-auto border border-border bg-popover px-3 py-2.5 text-left text-popover-foreground shadow-sm [text-wrap:wrap]";
const EVENT_TOOLTIP_CLASS =
  "w-[min(480px,calc(100vw-48px))] max-w-[calc(100vw-48px)] overflow-auto border border-border bg-popover px-3 py-2.5 text-left text-popover-foreground shadow-sm [text-wrap:wrap]";

type DotGroup = "human" | "delivery" | "problem";
type StackGrouping = "token-type" | "model" | "activity-phase" | "owner";

type ModelCosts = { cIn: number; cOut: number; cCache: number };
type ActivityPhase =
  | "Planning"
  | "Research"
  | "Implementation"
  | "Verification";
type StackSegment = {
  key: string;
  label: string;
  value: number;
  color: string;
};

type TimelineBucket = {
  key: string;
  label: string;
  atMinutes: number;
  cIn: number;
  cOut: number;
  cCache: number;
  total: number;
  toolStart: number;
  traceRow: number | null;
  byModel: Record<string, ModelCosts>;
  byPhase: Partial<Record<ActivityPhase, number>>;
};

const SCALE_OPTIONS = Object.values(TimelineScale);
const STACK_GROUPINGS: readonly {
  value: StackGrouping;
  label: string;
}[] = [
  { value: "token-type", label: "Token Type" },
  { value: "model", label: "Model" },
  { value: "activity-phase", label: "Activity phase" },
  { value: "owner", label: "Session Owner" },
];
const DOT_GROUP_ORDER: DotGroup[] = ["human", "delivery", "problem"];

const DOT_GROUP_CONFIG: Record<DotGroup, { color: string; label: string }> = {
  human: { color: "var(--primary)", label: "Human steering" },
  delivery: { color: "var(--success)", label: "Commits & PRs" },
  problem: {
    color: "var(--destructive)",
    label: "Failures, limits & corrections",
  },
};

function clockLabel(totalMinutes: number): string {
  const wholeMinutes = Math.floor(totalMinutes);
  const wrapped = ((wholeMinutes % 1440) + 1440) % 1440;
  const hours24 = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  const period = hours24 < 12 ? "AM" : "PM";
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${String(minutes).padStart(2, "0")} ${period}`;
}

function axisLabel(totalMinutes: number, includeDay: boolean): string {
  const day = Math.floor(totalMinutes / 1440) + 1;
  return includeDay
    ? `Day ${day} · ${clockLabel(totalMinutes)}`
    : clockLabel(totalMinutes);
}

function elapsedMinutes(label: string): number {
  const [hours, minutes] = label.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function formatMoney(value: number): string {
  return `$${value < 0.01 ? "0.00" : value.toFixed(2)}`;
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

function bucketCost(bucket: TimelineBucket): number {
  return bucket.cIn + bucket.cOut + bucket.cCache;
}

function groupingLabel(grouping: StackGrouping): string {
  return (
    STACK_GROUPINGS.find((option) => option.value === grouping)?.label ??
    "Group"
  );
}

function stackSegments(
  bucket: TimelineBucket,
  grouping: StackGrouping,
  ownerName: string,
  modelColors: ReadonlyMap<string, string>
): StackSegment[] {
  const cost = bucketCost(bucket);
  if (cost <= 0) {
    return [];
  }
  if (grouping === "token-type") {
    return [
      {
        key: "cache",
        label: "Cache",
        value: bucket.cCache,
        color: "var(--chart-3)",
      },
      {
        key: "output",
        label: "Output",
        value: bucket.cOut,
        color: "var(--chart-2)",
      },
      {
        key: "input",
        label: "Input",
        value: bucket.cIn,
        color: "var(--chart-1)",
      },
    ].filter((segment) => segment.value > 0);
  }
  if (grouping === "model") {
    return Object.entries(bucket.byModel)
      .map(([model, costs]) => ({
        key: model,
        label: model,
        value: costs.cIn + costs.cOut + costs.cCache,
        color: modelColors.get(model) ?? "var(--chart-1)",
      }))
      .filter((segment) => segment.value > 0);
  }
  if (grouping === "activity-phase") {
    const phaseColors: Record<ActivityPhase, string> = {
      Planning: "var(--chart-4)",
      Research: "var(--chart-2)",
      Implementation: "var(--chart-1)",
      Verification: "var(--chart-3)",
    };
    return Object.entries(bucket.byPhase).map(([phase, value]) => ({
      key: phase,
      label: phase,
      value,
      color: phaseColors[phase as ActivityPhase],
    }));
  }
  return [
    {
      key: ownerName,
      label: ownerName,
      value: cost,
      color: "var(--chart-1)",
    },
  ];
}

export function SessionTimeline({
  detail,
  activeMinutes,
  onJump,
}: {
  detail: SessionDetail;
  activeMinutes: number;
  onJump: (row: number, atMinutes?: number) => void;
}) {
  const [scale, setScale] = useState<TimelineScaleType>(() =>
    defaultTimelineScale(detail.durationMinutes)
  );
  const [windowStart, setWindowStart] = useState(0);
  const [stackGrouping, setStackGrouping] =
    useState<StackGrouping>("token-type");
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
  const safeWindowStart = Math.min(windowStart, maxWindowStart);
  const visibleStartMinutes = safeWindowStart * scaleMinutes;
  const visibleEndMinutes = visibleStartMinutes + visibleBars * scaleMinutes;
  const showDayContext = visibleEndMinutes - visibleStartMinutes >= 1440;

  const buckets = useMemo(() => {
    const result: TimelineBucket[] = Array.from(
      { length: visibleBars },
      (_, visibleIndex) => {
        const absoluteIndex = safeWindowStart + visibleIndex;
        const bucketStart = absoluteIndex * scaleMinutes;
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
          cIn: 0,
          cOut: 0,
          cCache: 0,
          total: 0,
          toolStart: 0,
          traceRow: null,
          byModel: {},
          byPhase: {},
        };
      }
    );

    const visibleBucketIndex = (atMinutes: number) => {
      const timelineMinutes = sessionStartOffsetMinutes + atMinutes;
      return Math.floor(timelineMinutes / scaleMinutes) - safeWindowStart;
    };

    for (const event of detail.costEvents) {
      const bucket = result[visibleBucketIndex(event.atMinutes)];
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
    }

    const tracePoints = detail.trace.map((turn, index) => ({
      atMinutes: elapsedMinutes(turn.timeLabel),
      row: turn.row ?? index,
    }));
    for (const [index, turn] of detail.trace.entries()) {
      const bucket = result[visibleBucketIndex(elapsedMinutes(turn.timeLabel))];
      if (!bucket) {
        continue;
      }
      bucket.total += 1;
      bucket.toolStart += turn.blocks.filter(
        (block) => block.type === "tools"
      ).length;
      bucket.traceRow ??= turn.row ?? index;
    }

    // A cost event can occupy a clock bucket between transcript turns. Keep
    // every active bar clickable by resolving it to the closest rendered turn,
    // while buckets containing turns continue to target their first turn.
    for (const [visibleIndex, bucket] of result.entries()) {
      if (bucketCost(bucket) <= 0 || bucket.traceRow != null) {
        continue;
      }
      const absoluteIndex = safeWindowStart + visibleIndex;
      const bucketMidpoint =
        absoluteIndex * scaleMinutes -
        sessionStartOffsetMinutes +
        scaleMinutes / 2;
      const nearest = tracePoints.reduce<
        { atMinutes: number; row: number } | undefined
      >((resolved, point) => {
        if (!resolved) {
          return point;
        }
        return Math.abs(point.atMinutes - bucketMidpoint) <
          Math.abs(resolved.atMinutes - bucketMidpoint)
          ? point
          : resolved;
      }, undefined);
      bucket.traceRow = nearest?.row ?? null;
    }
    return result;
  }, [
    detail.costEvents,
    detail.durationMinutes,
    detail.trace,
    safeWindowStart,
    scale,
    scaleMinutes,
    sessionStartOffsetMinutes,
    timelineOriginMinutes,
  ]);

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
        Math.floor(timelineMinutes / scaleMinutes) - safeWindowStart;
      const cell = cells[index];
      if (cell) {
        cell[markerGroup(marker.kind)].push(marker);
      }
    }
    return cells;
  }, [
    detail.timelineMarkers,
    safeWindowStart,
    scaleMinutes,
    sessionStartOffsetMinutes,
    buckets,
  ]);

  const maxCost = Math.max(
    0.01,
    ...buckets.map((bucket) => bucket.cIn + bucket.cOut + bucket.cCache)
  );
  const activeAbsoluteBucket = timelineBucketIndex(
    activeMinutes,
    sessionStartOffsetMinutes,
    scaleMinutes
  );
  const activeBucketIndex = activeAbsoluteBucket - safeWindowStart;

  useEffect(() => {
    const absoluteBucket = timelineBucketIndex(
      activeMinutes,
      sessionStartOffsetMinutes,
      scaleMinutes
    );
    const nextWindowStart = timelineWindowStart(
      absoluteBucket,
      safeWindowStart,
      maxWindowStart,
      MAX_VISIBLE_BARS
    );
    if (nextWindowStart !== safeWindowStart) {
      setWindowStart(nextWindowStart);
    }
  }, [
    activeMinutes,
    maxWindowStart,
    safeWindowStart,
    scaleMinutes,
    sessionStartOffsetMinutes,
  ]);

  const changeScale = (next: string) => {
    if (!next) {
      return;
    }
    const nextScale = next as TimelineScaleType;
    const currentMidpointClockMinutes =
      timelineOriginMinutes +
      visibleStartMinutes +
      (visibleEndMinutes - visibleStartMinutes) / 2;
    const nextScaleMinutes = SCALE_MINUTES[nextScale];
    const nextOriginMinutes =
      Math.floor(detail.timelineStartMinutes / nextScaleMinutes) *
      nextScaleMinutes;
    const nextSessionStartOffset =
      detail.timelineStartMinutes - nextOriginMinutes;
    const nextTimelineSpan = nextSessionStartOffset + detail.durationMinutes;
    const nextTotalBars = Math.max(
      1,
      Math.ceil(nextTimelineSpan / nextScaleMinutes)
    );
    const nextVisibleBars = MAX_VISIBLE_BARS;
    const nextMaxStart = Math.max(0, nextTotalBars - nextVisibleBars);
    const centeredStart = Math.round(
      (currentMidpointClockMinutes - nextOriginMinutes) / nextScaleMinutes -
        nextVisibleBars / 2
    );
    setScale(nextScale);
    setWindowStart(Math.max(0, Math.min(nextMaxStart, centeredStart)));
  };

  return (
    <section aria-labelledby="session-timeline-heading">
      <div className="mb-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className={SECTION_TITLE_CLASS} id="session-timeline-heading">
          Session Costs Over Time
        </h2>
        <div className="ml-auto flex items-center gap-3 text-muted-foreground text-xs">
          <span>
            <b className="text-foreground tabular-nums">{detail.costLabel}</b>{" "}
            cost
          </span>
          <span>
            <b className="text-foreground tabular-nums">{detail.tokensLabel}</b>
          </span>
          <span className="font-semibold text-foreground">
            {detail.durationLabel}
          </span>
        </div>
      </div>

      <div className="mb-2 flex items-center justify-between gap-3">
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
        <div className="flex items-center gap-2">
          <span className="whitespace-nowrap text-muted-foreground text-xs">
            Group by
          </span>
          <Select
            onValueChange={(value) => setStackGrouping(value as StackGrouping)}
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

      <div className="relative pt-3.5">
        {activeBucketIndex < 0 || activeBucketIndex >= buckets.length ? null : (
          <div
            aria-hidden
            className="pointer-events-none absolute top-3.5 z-10 h-[78px] border-primary border-l-2"
            style={{
              left: `${((activeBucketIndex + 0.5) / buckets.length) * 100}%`,
            }}
          />
        )}
        <div className="flex h-[78px] items-end gap-0.5 border-b">
          {buckets.map((bucket) => (
            <CostBarCell
              bucket={bucket}
              grouping={stackGrouping}
              key={bucket.key}
              maxCost={maxCost}
              modelColors={modelColors}
              onJump={onJump}
              ownerName={detail.ownerName}
            />
          ))}
        </div>

        <div className="mt-1.5 flex min-h-9 gap-0.5">
          {markerCells.map((cell) => (
            <div
              className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
              key={`markers-${cell.key}`}
            >
              {DOT_GROUP_ORDER.map((group) =>
                cell[group].length > 0 ? (
                  <MarkerGroupDot
                    events={cell[group]}
                    group={group}
                    key={group}
                    onJump={onJump}
                    timelineStartMinutes={detail.timelineStartMinutes}
                  />
                ) : null
              )}
            </div>
          ))}
        </div>

        <div className="mt-1 flex justify-between text-muted-foreground text-xs tabular-nums">
          <span>
            {axisLabel(
              timelineOriginMinutes + visibleStartMinutes,
              showDayContext
            )}
          </span>
          <span>
            {axisLabel(
              timelineOriginMinutes + visibleEndMinutes,
              showDayContext
            )}
          </span>
        </div>
      </div>

      {maxWindowStart > 0 ? (
        <div className="mt-3 flex items-center gap-3">
          <span className="shrink-0 text-muted-foreground text-xs">
            Session
          </span>
          <input
            aria-label="Session time position"
            className="h-1.5 w-full cursor-ew-resize accent-primary"
            max={Math.max(1, Math.round(detail.durationMinutes))}
            min={0}
            onChange={(event) => {
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
              onJump(nearest.row, atMinutes);
            }}
            step={1}
            type="range"
            value={Math.min(
              Math.round(detail.durationMinutes),
              Math.round(activeMinutes)
            )}
          />
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
            {Math.round(
              (activeMinutes / Math.max(1, detail.durationMinutes)) * 100
            )}
            %
          </span>
        </div>
      ) : null}
    </section>
  );
}

function CostBarCell({
  bucket,
  grouping,
  maxCost,
  onJump,
  ownerName,
  modelColors,
}: {
  bucket: TimelineBucket;
  grouping: StackGrouping;
  maxCost: number;
  onJump: (row: number, atMinutes?: number) => void;
  ownerName: string;
  modelColors: ReadonlyMap<string, string>;
}) {
  const cost = bucketCost(bucket);
  const segments = stackSegments(bucket, grouping, ownerName, modelColors);
  const idle = cost === 0;
  const height = idle
    ? 7
    : Math.max(9, Math.round((Math.sqrt(cost) / Math.sqrt(maxCost)) * 100));
  const showLabel = !idle && cost >= maxCost * 0.16;
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button
          aria-label={
            bucket.traceRow == null
              ? `Activity bucket ${bucket.label}`
              : `Jump to activity bucket ${bucket.label}`
          }
          className={
            idle
              ? "min-w-0 flex-1 self-end bg-[repeating-linear-gradient(45deg,transparent,transparent_2px,color-mix(in_oklab,var(--muted-foreground)_34%,transparent)_2px,color-mix(in_oklab,var(--muted-foreground)_34%,transparent)_4px)] outline-offset-1 hover:outline hover:outline-1 hover:outline-primary/50 focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary/50"
              : "relative flex min-h-[3px] min-w-0 flex-1 flex-col justify-end overflow-visible rounded-t-[2px] outline-offset-1 hover:outline hover:outline-1 hover:outline-primary/50 focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary/50"
          }
          onClick={() => {
            if (bucket.traceRow != null) {
              onJump(bucket.traceRow, bucket.atMinutes);
            }
          }}
          style={{ height: `${height}%` }}
          type="button"
        >
          {showLabel ? (
            <span className="absolute -top-4 left-1/2 -translate-x-1/2 font-semibold text-xs tabular-nums">
              ${cost < 1 ? cost.toFixed(1) : Math.round(cost)}
            </span>
          ) : null}
          {idle ? null : (
            <span className="flex h-full w-full flex-col justify-end overflow-hidden rounded-t-[2px]">
              {segments.map((segment) => (
                <span
                  className="block w-full"
                  key={segment.key}
                  style={{
                    background: segment.color,
                    height: `${(segment.value / cost) * 100}%`,
                  }}
                />
              ))}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent className={COST_TOOLTIP_CLASS} hideArrow>
        <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
          <b>{bucket.label}</b>
          {idle ? null : (
            <span className="tabular-nums">{formatMoney(cost)}</span>
          )}
        </div>
        {idle ? (
          <p className="text-muted-foreground text-xs italic">
            Agent asleep · scheduled wake-up · no tokens billed
          </p>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="text-muted-foreground text-xs">
              <tr>
                <th className="py-0.5 pb-1 text-left font-medium">
                  {groupingLabel(grouping).toLowerCase()}
                </th>
                <th className="pb-1 text-right font-medium">cost</th>
              </tr>
            </thead>
            <tbody>
              {segments.map((segment) => (
                <tr key={segment.key}>
                  <td className="max-w-44 truncate py-px pr-2">
                    <span
                      className="mr-1.5 inline-block size-2 rounded-sm"
                      style={{ background: segment.color }}
                    />
                    {segment.label}
                  </td>
                  <td className="py-px text-right tabular-nums">
                    {formatMoney(segment.value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-1.5 text-muted-foreground text-xs">
          {bucket.total} events · {bucket.toolStart} tool calls
          {bucket.traceRow == null ? "" : " · Click to open in trace"}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

function MarkerGroupDot({
  events,
  group,
  onJump,
  timelineStartMinutes,
}: {
  events: TimelineMarker[];
  group: DotGroup;
  onJump: (row: number, atMinutes?: number) => void;
  timelineStartMinutes: number;
}) {
  const config = DOT_GROUP_CONFIG[group];
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button
          aria-label={`Jump to ${config.label}`}
          className="group flex size-6 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onJump(events[0].traceRow, events[0].atMinutes)}
          type="button"
        >
          <span
            aria-hidden
            className="size-2 rounded-full transition-transform group-hover:scale-125"
            style={{ background: config.color }}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent className={EVENT_TOOLTIP_CLASS} hideArrow>
        <div className="mb-1.5 flex items-center gap-1.5 text-xs">
          <span
            className="size-2 rounded-full"
            style={{ background: config.color }}
          />
          <span className="font-medium">{config.label}</span>
          {events.length > 1 ? (
            <span className="ml-auto text-muted-foreground">
              {events.length} events
            </span>
          ) : null}
        </div>
        <div className="flex max-h-[220px] flex-col gap-[5px] overflow-y-auto">
          {events.map((event) => (
            <div
              className="grid grid-cols-[minmax(112px,max-content)_auto_minmax(0,1fr)] items-baseline gap-2 text-xs leading-normal"
              key={`${event.kind}-${event.atMinutes}-${event.traceRow}`}
            >
              <span className="whitespace-nowrap font-mono text-muted-foreground text-xs tabular-nums">
                {clockLabel(timelineStartMinutes + event.atMinutes)}
              </span>
              <span className="whitespace-nowrap rounded-sm border px-1.5 text-muted-foreground text-xs uppercase tracking-wide">
                {event.kind}
              </span>
              <span className="min-w-0 break-words">{event.label}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-muted-foreground text-xs">
          Click the dot to jump to {events.length > 1 ? "the first" : "this"} in
          the trace
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
