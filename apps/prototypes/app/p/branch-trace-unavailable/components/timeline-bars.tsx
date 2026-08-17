"use client";

// Faithful copy of the PR-timeline bars + event-dot rail from the branches
// prototype's sessions-timeline (the flow owner, `app/p/branches`), so this
// bug-fix prototype renders the identical tab. Duplicated rather than imported
// because the originals are module-private there; the one behavioral addition
// is the empty-read guard in TimelineBars (zero columns = the failed trace
// read this prototype is about).

import { chartColorPairForTokenIndex } from "@repo/design-system/components/ui/chart-colors";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { positionEventDots } from "@/app/p/branches/components/event-dot-position";
import type { BranchDetail, EventDot } from "@/app/p/branches/mock";
import {
  timelineColumnHeightPct,
  timelineTokenTotal,
} from "@/app/p/branches/timeline-fixtures";

const DOT_COLOR: Record<EventDot["kind"], string> = {
  blue: "var(--primary)",
  green: "var(--success)",
  red: "var(--destructive)",
};

const DOT_TEXT_COLOR: Record<EventDot["kind"], string> = {
  blue: "var(--primary)",
  green: "var(--success-foreground)",
  red: "var(--destructive)",
};

const DOT_LABEL: Record<EventDot["kind"], string> = {
  blue: "Human steering",
  green: "Commits & PRs",
  red: "Failures & limits",
};

export type TimelineActorEntry = { color: string; id: string; name: string };

export function TimelineBars({
  actorEntries,
  detail,
  onJumpToTurn,
}: {
  actorEntries: TimelineActorEntry[];
  detail: BranchDetail;
  onJumpToTurn: (turnId: string) => void;
}) {
  const { timeline } = detail;
  const fallbackActor = {
    color: chartColorPairForTokenIndex(0).base,
    id: "contributor",
    name: "Contributor",
  };
  const actorById = new Map(actorEntries.map((entry) => [entry.id, entry]));
  const actorColorBySessionColor = new Map(
    timeline.legend.map((entry) => [
      entry.color,
      actorById.get(entry.actorId)?.color ?? fallbackActor.color,
    ])
  );
  const actorBySessionColor = new Map(
    timeline.legend.map((entry) => [
      entry.color,
      actorById.get(entry.actorId) ?? fallbackActor,
    ])
  );
  const maxTokens = Math.max(1, ...timeline.columns.map(timelineTokenTotal));
  // The bug state, drawn honestly to what production does today: a failed
  // trace read leaves zero columns, so the strip renders with nothing in it —
  // no bars, no dots, no time axis — under a header that still claims a
  // session population.
  if (timeline.columns.length === 0) {
    return (
      <div className="relative pt-3.5">
        <div className="flex h-[92px] items-end gap-0.5 border-b" />
      </div>
    );
  }
  return (
    <div className="relative pt-3.5">
      <div className="flex h-[92px] items-end gap-0.5 border-b">
        {timeline.columns.map((column, index) =>
          column.idle ? (
            <span
              className="h-1.5 flex-1 self-end bg-[repeating-linear-gradient(45deg,transparent,transparent_2px,var(--muted-foreground)_2px,var(--muted-foreground)_4px)] opacity-40"
              // biome-ignore lint/suspicious/noArrayIndexKey: positional bars.
              key={`col-${index}`}
            />
          ) : (
            <Tooltip
              // biome-ignore lint/suspicious/noArrayIndexKey: positional bars.
              key={`col-${index}`}
            >
              <TooltipTrigger asChild>
                <button
                  aria-label={`Show token breakdown for ${timelineColumnRange(
                    timeline.startLabel,
                    timeline.endLabel,
                    index,
                    timeline.columns.length
                  )}`}
                  className="flex h-full flex-1 items-end p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  type="button"
                >
                  <span
                    className="flex min-h-[3px] w-full flex-col overflow-hidden rounded-t-[2px]"
                    style={{
                      height: `${timelineColumnHeightPct(column, maxTokens)}%`,
                    }}
                  >
                    {column.segments.map((segment, segIndex) => (
                      <span
                        className="block w-full"
                        // biome-ignore lint/suspicious/noArrayIndexKey: positional segments.
                        key={`seg-${segIndex}`}
                        style={{
                          height: `${segment.pct}%`,
                          background:
                            actorColorBySessionColor.get(segment.color) ??
                            fallbackActor.color,
                        }}
                      />
                    ))}
                  </span>
                </button>
              </TooltipTrigger>
              <TimelineBarTooltip
                actors={columnActorBreakdown(
                  column.segments,
                  actorBySessionColor
                )}
                range={timelineColumnRange(
                  timeline.startLabel,
                  timeline.endLabel,
                  index,
                  timeline.columns.length
                )}
                tokens={column.tokens}
              />
            </Tooltip>
          )
        )}
      </div>

      <EventDotRail detail={detail} onJumpToTurn={onJumpToTurn} />

      <div className="mt-1 flex justify-between font-mono text-[11px] text-muted-foreground">
        <span>{timeline.startLabel}</span>
        <span>{timeline.endLabel}</span>
      </div>
    </div>
  );
}

function TimelineBarTooltip({
  actors,
  range,
  tokens,
}: {
  actors: { color: string; name: string; pct: number }[];
  range: string;
  tokens: BranchDetail["timeline"]["columns"][number]["tokens"];
}) {
  const totalTokens = tokens.input + tokens.output + tokens.cacheRead;
  return (
    <TooltipContent
      className="w-64 rounded-xl border bg-popover p-3 text-popover-foreground shadow-xl [&>[data-radix-popper-arrow]]:hidden [&>svg]:hidden"
      side="top"
      sideOffset={8}
    >
      <div className="mb-2 flex items-center justify-between gap-4 font-semibold text-sm">
        <span>{range}</span>
        <span>{formatTokens(totalTokens)}</span>
      </div>
      <div className="flex flex-col">
        {actors.map((actor, index) => {
          const actorTokens = Math.round((totalTokens * actor.pct) / 100);
          return (
            <div
              className={`py-2 first:pt-0 last:pb-0 ${
                index > 0 ? "border-t" : ""
              }`}
              key={`${actor.name}-${actor.color}`}
            >
              <div className="mb-1 flex items-center gap-2 text-sm">
                <span
                  className="size-3 shrink-0 rounded-[3px]"
                  style={{ background: actor.color }}
                />
                <span className="min-w-0 flex-1 truncate">{actor.name}</span>
                <span className="text-muted-foreground">
                  {formatTokens(actorTokens)}
                </span>
              </div>
            </div>
          );
        })}
        <div className="mt-2 border-t pt-2">
          <TokenBreakdownRow
            color="var(--chart-1)"
            label="Input"
            value={formatTokens(tokens.input)}
          />
          <TokenBreakdownRow
            color="var(--chart-2)"
            label="Output"
            value={formatTokens(tokens.output)}
          />
          <TokenBreakdownRow
            color="var(--muted-foreground)"
            label="Cache read"
            value={formatTokens(tokens.cacheRead)}
          />
        </div>
      </div>
    </TooltipContent>
  );
}

function TokenBreakdownRow({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2 pl-5 text-muted-foreground text-xs">
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ background: color }}
      />
      <span className="flex-1">{label}</span>
      <span className="text-foreground tabular-nums">{value}</span>
    </div>
  );
}

function columnActorBreakdown(
  segments: readonly { color: string; pct: number }[],
  actorBySessionColor: ReadonlyMap<string, { color: string; name: string }>
): { color: string; name: string; pct: number }[] {
  const grouped = new Map<
    string,
    { color: string; name: string; pct: number }
  >();
  for (const segment of segments) {
    const actor = actorBySessionColor.get(segment.color) ?? {
      color: chartColorPairForTokenIndex(0).base,
      name: "Contributor",
    };
    const key = `${actor.name}-${actor.color}`;
    const current = grouped.get(key);
    grouped.set(key, {
      ...actor,
      pct: (current?.pct ?? 0) + segment.pct,
    });
  }
  return [...grouped.values()];
}

function timelineColumnRange(
  startLabel: string,
  endLabel: string,
  index: number,
  columnCount: number
): string {
  const parseMinutes = (label: string) => {
    const [hours = 0, minutes = 0] = label.split(":").map(Number);
    return hours * 60 + minutes;
  };
  const formatMinutes = (value: number) => {
    const normalized = Math.round(value) % (24 * 60);
    return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(
      normalized % 60
    ).padStart(2, "0")}`;
  };
  const start = parseMinutes(startLabel);
  const end = parseMinutes(endLabel);
  const width = (end - start) / columnCount;
  return `${formatMinutes(start + width * index)}–${formatMinutes(
    start + width * (index + 1)
  )}`;
}

function formatTokens(value: number): string {
  if (value >= 1000) {
    return `${Math.round(value / 1000)}k`;
  }
  return String(value);
}

function EventDotRail({
  detail,
  onJumpToTurn,
}: {
  detail: BranchDetail;
  onJumpToTurn: (turnId: string) => void;
}) {
  const positionedDots = positionEventDots(
    detail.eventDots,
    detail.timeline.columns.length
  );
  const stackRows = Math.max(
    1,
    ...positionedDots.map(({ stackIndex }) => stackIndex + 1)
  );

  return (
    <div className="relative mt-1">
      <div className="relative" style={{ height: `${stackRows * 24}px` }}>
        {positionedDots.map(({ dot, leftPct, stackIndex }) => (
          <Tooltip key={`${dot.at}-${dot.label}`}>
            <TooltipTrigger asChild>
              <button
                aria-label={`Jump to ${DOT_LABEL[dot.kind]}: ${dot.label}`}
                className="group absolute flex size-6 -translate-x-1/2 items-center justify-center rounded-full p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onJumpToTurn(dot.targetTurnId)}
                style={{
                  left: `${leftPct}%`,
                  top: `${stackIndex * 24}px`,
                }}
                type="button"
              >
                <span
                  className="size-3 rounded-full ring-2 ring-background transition-transform duration-100 group-hover:scale-125"
                  style={{ background: DOT_COLOR[dot.kind] }}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent
              className="flex w-auto max-w-72 flex-col gap-1 p-3 [&>[data-radix-popper-arrow]]:hidden [&>svg]:hidden"
              side="top"
            >
              <span
                className="inline-flex items-center gap-1.5 font-medium text-xs"
                style={{ color: DOT_TEXT_COLOR[dot.kind] }}
              >
                <span
                  className="size-2 rounded-full"
                  style={{ background: DOT_COLOR[dot.kind] }}
                />
                {DOT_LABEL[dot.kind]}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {dot.at}
              </span>
              <span className="text-xs">{dot.label}</span>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
