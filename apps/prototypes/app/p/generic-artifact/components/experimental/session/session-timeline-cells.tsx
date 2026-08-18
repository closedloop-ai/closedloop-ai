"use client";

// Prototype-local session presentation pending a separate Sessions review.

import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import type { TimelineMarker } from "./mock-detail";
import type { SessionActorEntry } from "./session-actor-colors";
import type { TimelineJumpHandler } from "./session-timeline";
import { sortTimelineEventsByMinute } from "./timeline-model";

export type DotGroup = "human" | "delivery" | "problem";
export type SessionTimelineGrouping =
  | "token-type"
  | "model"
  | "activity-phase"
  | "actor";
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
export type TimelineBucket = {
  key: string;
  label: string;
  atMinutes: number;
  startMinutes: number;
  endMinutes: number;
  cIn: number;
  cOut: number;
  cCache: number;
  total: number;
  toolStart: number;
  traceRow: number | null;
  byModel: Record<string, ModelCosts>;
  byPhase: Partial<Record<ActivityPhase, number>>;
  byActor: Record<string, number>;
};

export const DOT_GROUP_ORDER: DotGroup[] = ["human", "delivery", "problem"];
const DOT_GROUP_CONFIG: Record<DotGroup, { color: string; label: string }> = {
  human: { color: "var(--primary)", label: "Human steering" },
  delivery: { color: "var(--success)", label: "Commits & PRs" },
  problem: {
    color: "var(--destructive)",
    label: "Failures, limits & corrections",
  },
};
const COST_TOOLTIP_CLASS =
  "w-[260px] max-w-[calc(100vw-48px)] overflow-auto border border-border bg-popover px-3 py-2.5 text-left text-popover-foreground shadow-sm [text-wrap:wrap]";
const EVENT_TOOLTIP_CLASS =
  "w-[min(480px,calc(100vw-48px))] max-w-[calc(100vw-48px)] overflow-auto border border-border bg-popover px-3 py-2.5 text-left text-popover-foreground shadow-sm [text-wrap:wrap]";

export function clockLabel(totalMinutes: number): string {
  const wholeMinutes = Math.floor(totalMinutes);
  const wrapped = ((wholeMinutes % 1440) + 1440) % 1440;
  const hours24 = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  const period = hours24 < 12 ? "AM" : "PM";
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${String(minutes).padStart(2, "0")} ${period}`;
}

export function bucketCost(bucket: TimelineBucket): number {
  return bucket.cIn + bucket.cOut + bucket.cCache;
}

function formatMoney(value: number): string {
  return `$${value < 0.01 ? "0.00" : value.toFixed(2)}`;
}

function groupingLabel(grouping: SessionTimelineGrouping): string {
  return {
    "token-type": "Token Type",
    model: "Model",
    "activity-phase": "Activity phase",
    actor: "Actor",
  }[grouping];
}

function stackSegments(
  bucket: TimelineBucket,
  grouping: SessionTimelineGrouping,
  modelColors: ReadonlyMap<string, string>,
  actorEntries: readonly SessionActorEntry[]
): StackSegment[] {
  if (bucketCost(bucket) <= 0) {
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
    const colors: Record<ActivityPhase, string> = {
      Planning: "var(--chart-4)",
      Research: "var(--chart-2)",
      Implementation: "var(--chart-1)",
      Verification: "var(--chart-3)",
    };
    return Object.entries(bucket.byPhase).map(([phase, value]) => ({
      key: phase,
      label: phase,
      value,
      color: colors[phase as ActivityPhase],
    }));
  }
  const actorById = new Map(actorEntries.map((actor) => [actor.id, actor]));
  return Object.entries(bucket.byActor)
    .map(([actorId, value]) => ({
      key: actorId,
      label: actorById.get(actorId)?.name ?? "Contributor",
      value,
      color: actorById.get(actorId)?.colors.base ?? "var(--chart-1)",
    }))
    .filter((segment) => segment.value > 0);
}

export function CostBarCell({
  bucket,
  grouping,
  maxCost,
  onJumpAtMinutes,
  modelColors,
  actorEntries,
}: {
  bucket: TimelineBucket;
  grouping: SessionTimelineGrouping;
  maxCost: number;
  onJumpAtMinutes: (atMinutes: number, clientX: number) => void;
  modelColors: ReadonlyMap<string, string>;
  actorEntries: readonly SessionActorEntry[];
}) {
  const cost = bucketCost(bucket);
  const segments = stackSegments(bucket, grouping, modelColors, actorEntries);
  const idle = cost === 0;
  const height = idle
    ? 7
    : Math.max(9, Math.round((Math.sqrt(cost) / Math.sqrt(maxCost)) * 100));
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button
          aria-label={`Jump to timeline bucket ${bucket.label}${idle ? ", no cost" : `, ${formatMoney(cost)}`}`}
          className="group relative flex h-full min-w-0 flex-1 items-end focus-visible:outline-none"
          onBlur={(event) =>
            event.currentTarget.style.removeProperty("--timeline-hover-x")
          }
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const progress =
              bounds.width <= 0
                ? 0.5
                : Math.max(
                    0,
                    Math.min(1, (event.clientX - bounds.left) / bounds.width)
                  );
            onJumpAtMinutes(
              bucket.startMinutes +
                (bucket.endMinutes - bucket.startMinutes) * progress,
              event.clientX
            );
          }}
          onPointerLeave={(event) =>
            event.currentTarget.style.removeProperty("--timeline-hover-x")
          }
          onPointerMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            event.currentTarget.style.setProperty(
              "--timeline-hover-x",
              `${Math.max(0, Math.min(bounds.width, event.clientX - bounds.left))}px`
            );
          }}
          type="button"
        >
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 z-10 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-muted-foreground/35 group-focus-visible:bg-muted-foreground/50"
            style={{ left: "var(--timeline-hover-x, 50%)" }}
          />
          <span
            className={
              idle
                ? "relative flex w-full bg-[repeating-linear-gradient(45deg,transparent,transparent_2px,color-mix(in_oklab,var(--muted-foreground)_34%,transparent)_2px,color-mix(in_oklab,var(--muted-foreground)_34%,transparent)_4px)]"
                : "relative flex w-full flex-col justify-end overflow-visible rounded-t-[2px]"
            }
            style={{ height: `${height}%` }}
          >
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
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent className={`${COST_TOOLTIP_CLASS} [&>svg]:hidden`}>
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
            <thead className="text-muted-foreground">
              <tr>
                <th className="pb-1 text-left font-medium">
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
          {bucket.total} events · {bucket.toolStart} tool calls · Click anywhere
          in this interval to navigate
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

export function MarkerGroupDot({
  events,
  group,
  onJump,
  timelineStartMinutes,
}: {
  events: TimelineMarker[];
  group: DotGroup;
  onJump: TimelineJumpHandler;
  timelineStartMinutes: number;
}) {
  const config = DOT_GROUP_CONFIG[group];
  const orderedEvents = sortTimelineEventsByMinute(events);
  const firstEvent = orderedEvents[0];
  if (!firstEvent) {
    return null;
  }
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button
          aria-label={
            orderedEvents.length > 1
              ? `Jump to first of ${orderedEvents.length} ${config.label} events`
              : `Jump to ${config.label}`
          }
          className="group flex h-[10px] w-6 shrink-0 items-center justify-center self-center rounded-sm transition-colors hover:bg-muted hover:ring-1 hover:ring-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-event-count={orderedEvents.length}
          data-event-group={group}
          data-first-event-minutes={firstEvent.atMinutes}
          onClick={() => onJump(firstEvent.traceRow, firstEvent.atMinutes)}
          type="button"
        >
          <span
            aria-hidden
            className="size-2 rounded-full transition-transform group-hover:scale-125"
            style={{ background: config.color }}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent className={`${EVENT_TOOLTIP_CLASS} [&>svg]:hidden`}>
        <div className="mb-1.5 flex items-center gap-1.5 text-xs">
          <span
            className="size-2 rounded-full"
            style={{ background: config.color }}
          />
          <span className="font-medium">{config.label}</span>
          {orderedEvents.length > 1 ? (
            <span className="ml-auto text-muted-foreground">
              {orderedEvents.length} events
            </span>
          ) : null}
        </div>
        <div className="flex max-h-[220px] flex-col gap-[5px] overflow-y-auto">
          {orderedEvents.map((event) => (
            <div
              className="grid grid-cols-[minmax(112px,max-content)_auto_minmax(0,1fr)] items-baseline gap-2 text-xs leading-normal"
              key={`${event.kind}-${event.atMinutes}-${event.traceRow}`}
            >
              <span className="whitespace-nowrap font-mono text-muted-foreground tabular-nums">
                {clockLabel(timelineStartMinutes + event.atMinutes)}
              </span>
              <span className="whitespace-nowrap rounded-sm border px-1.5 text-muted-foreground uppercase tracking-wide">
                {event.kind}
              </span>
              <span className="min-w-0 break-words">{event.label}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-muted-foreground text-xs">
          Click the dot to jump to{" "}
          {orderedEvents.length > 1 ? "the first" : "this"} in the trace
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
