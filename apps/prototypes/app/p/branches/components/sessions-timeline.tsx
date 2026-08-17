"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import {
  type ChartColorPair,
  chartColorPairForTokenIndex,
} from "@repo/design-system/components/ui/chart-colors";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  type BranchDetail,
  type EventDot,
  TRACE_USERS,
  type TraceBlock,
  type TraceInline,
  type TraceTurn,
} from "../mock";
import {
  projectTimelineCompleteness,
  type TimelineCompletenessProjection,
} from "../timeline-completeness-fixtures";
import {
  timelineColumnHeightPct,
  timelineTokenTotal,
} from "../timeline-fixtures";
import { positionEventDots } from "./event-dot-position";
import { BranchSessionsEmptyState } from "./sessions-empty-state";

// The design-system pair is the single source for every actor surface:
// base → timeline bars and legends, soft → human bubbles/avatar fills,
// strong → avatar foregrounds. Agent bubbles are the low-emphasis treatment of
// that same base hue.
const agentBubbleBg = (colors: ChartColorPair) =>
  `color-mix(in oklch, ${colors.base} 8%, var(--card))`;
const TOOLS_BODY_BG = "color-mix(in oklab, var(--card) 75%, transparent)";

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

// Matches the Agent-detail "Properties" title (`.prd-props-title`): 14px,
// semibold, muted-foreground, normal case — shared by every branch-detail
// section title.
const SECTION_TITLE_CLASS = "font-semibold text-foreground text-sm";
// The approved two-actor trace treatment uses the palette's canonical blue and
// orange slots. Models and CI helpers are execution metadata, not chart actors.
const TRACE_ACTOR_COLOR_INDEXES = [0, 4] as const;

// --- PR activity timeline (E1) + event dot rail (E3) -----------------------

function ActivitySection({
  detail,
  onJumpToTurn,
  projection,
}: {
  detail: BranchDetail;
  onJumpToTurn: (turnId: string) => void;
  projection: TimelineCompletenessProjection;
}) {
  const actorEntries = traceActorEntries(detail);
  const timingDisclosureId = useId();
  const projectedDetail = { ...detail, timeline: projection.timeline };
  return (
    <section>
      <div className="mb-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className={SECTION_TITLE_CLASS}>
          PR timeline
          <span className="ml-1 font-normal text-[11px] normal-case tracking-normal opacity-80">
            · {detail.sessions.length}{" "}
            {detail.sessions.length === 1 ? "session" : "sessions"}
          </span>
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          {actorEntries.map((entry) => (
            <span
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
              key={entry.name}
            >
              <span
                className="size-2 rounded-[2px]"
                style={{ background: entry.color }}
              />
              {entry.name}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-3 text-muted-foreground text-xs">
          <span>
            <b
              aria-describedby={
                projection.disclosure ? timingDisclosureId : undefined
              }
              className="text-foreground"
            >
              {projection.costLabel}
            </b>{" "}
            cost
          </span>
          <span>
            <b className="text-foreground">{detail.valuePerDollar}</b>
            {isLocPerDollarValue(detail.valuePerDollar) ? " LOC/$" : null}
          </span>
          <span
            aria-describedby={
              projection.disclosure ? timingDisclosureId : undefined
            }
            className="font-semibold text-foreground"
          >
            <span className="sr-only">Duration: </span>
            {projection.durationLabel}
          </span>
        </div>
      </div>

      {projection.hasBars ? (
        <TimelineBars
          actorEntries={actorEntries}
          detail={projectedDetail}
          onJumpToTurn={onJumpToTurn}
        />
      ) : (
        <p className="py-8 text-center text-muted-foreground text-sm">
          {projection.noBarsMessage}
        </p>
      )}
      {projection.disclosure ? (
        <p
          className="mt-2 text-muted-foreground text-xs"
          id={timingDisclosureId}
        >
          {projection.disclosure}
        </p>
      ) : null}
    </section>
  );
}

function isLocPerDollarValue(value: string): boolean {
  return value !== "Unavailable" && value !== "N/A";
}

function TimelineBars({
  actorEntries,
  detail,
  onJumpToTurn,
}: {
  actorEntries: { color: string; id: string; name: string }[];
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

// --- Combined session trace (D2) — the agents SessionTrace transcript ------

function TraceInlineSpan({ span }: { span: TraceInline }): ReactNode {
  if (typeof span === "string") {
    return span;
  }
  if ("code" in span) {
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">
        {span.code}
      </code>
    );
  }
  return <span className="text-primary">#{span.pr}</span>;
}

function TraceSpans({ spans }: { spans: TraceInline[] }): ReactNode {
  return spans.map((span, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: positional inline spans.
    <TraceInlineSpan key={index} span={span} />
  ));
}

function TraceTools({
  summary,
  rows,
}: {
  summary: string;
  rows: { label: string; detail?: string }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 py-[3px] text-left text-[0.78rem] text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        {open ? (
          <ChevronDownIcon aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
        )}
      </button>
      {open ? (
        <div
          className="my-1 flex flex-col rounded-md p-1"
          style={{ background: TOOLS_BODY_BG }}
        >
          {rows.map((row) => (
            <div
              className="flex items-center gap-2.5 rounded-sm px-2 py-1"
              key={`${row.label}-${row.detail ?? ""}`}
            >
              <span className="shrink-0 font-mono text-xs">{row.label}</span>
              {row.detail ? (
                <span className="min-w-0 truncate font-mono text-muted-foreground text-xs">
                  {row.detail}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TraceBlockView({ block }: { block: TraceBlock }): ReactNode {
  if (block.type === "p") {
    return (
      <p className="text-[0.8125rem] leading-[1.6]">
        <TraceSpans spans={block.spans} />
      </p>
    );
  }
  if (block.type === "ul") {
    return (
      <ul className="ml-4 flex list-disc flex-col gap-1 text-[0.8125rem] leading-[1.6]">
        {block.items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional list items.
          <li key={index}>
            <TraceSpans spans={item} />
          </li>
        ))}
      </ul>
    );
  }
  return <TraceTools rows={block.rows} summary={block.summary} />;
}

function TraceTurnView({
  turn,
  colors,
  active,
}: {
  turn: TraceTurn;
  colors: ChartColorPair;
  active: boolean;
}) {
  const human = turn.side === "human";
  const user = TRACE_USERS[turn.userId];
  return (
    <div
      aria-current={active ? "true" : undefined}
      className={`relative flex scroll-mt-6 rounded-lg py-[5px] pr-[5.75rem] transition-shadow ${
        human ? "justify-end" : "justify-start"
      } ${active ? "ring-2 ring-primary/40" : ""}`}
      data-trace-turn={turn.id}
      id={`branch-trace-turn-${turn.id}`}
    >
      <div
        className="flex w-4/5 flex-col gap-1.5 rounded-xl px-[0.8125rem] py-[0.5625rem]"
        style={{
          background: human ? colors.soft : agentBubbleBg(colors),
        }}
      >
        {turn.blocks.map((block, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional blocks.
          <TraceBlockView block={block} key={index} />
        ))}
        {!human && turn.model ? (
          <span className="self-end text-[0.65625rem] text-muted-foreground opacity-85">
            {turn.model}
          </span>
        ) : null}
      </div>
      <div className="absolute top-0 right-0 flex w-[4.875rem] flex-col items-end gap-1 pt-[0.5625rem]">
        {user ? (
          <Avatar aria-label={user.name} className="size-6" title={user.name}>
            <AvatarFallback
              className="font-medium text-[0.625rem]"
              style={{ background: colors.soft, color: colors.strong }}
            >
              {user.initials}
            </AvatarFallback>
          </Avatar>
        ) : null}
        <span className="text-[0.65625rem] text-muted-foreground leading-normal">
          {turn.timeLabel}
        </span>
        {turn.durationLabel ? (
          <span className="text-[0.65625rem] text-muted-foreground leading-normal">
            {turn.durationLabel}
          </span>
        ) : null}
        {turn.costLabel ? (
          <span className="text-[0.65625rem] text-foreground leading-normal">
            {turn.costLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Assign colors only to the human actors visible in the merged trace. Session
 * model/CI labels are deliberately excluded from the actor domain.
 */
function buildActorColorMap(detail: BranchDetail): Map<string, ChartColorPair> {
  const colorsByUserId = new Map<string, ChartColorPair>();
  for (const turn of detail.trace) {
    const user = TRACE_USERS[turn.userId];
    if (user && !colorsByUserId.has(turn.userId)) {
      const colorIndex =
        TRACE_ACTOR_COLOR_INDEXES[
          colorsByUserId.size % TRACE_ACTOR_COLOR_INDEXES.length
        ] ?? 0;
      colorsByUserId.set(turn.userId, chartColorPairForTokenIndex(colorIndex));
    }
  }
  return colorsByUserId;
}

function traceActorEntries(
  detail: BranchDetail
): { color: string; id: string; name: string }[] {
  const colorsByUserId = buildActorColorMap(detail);
  return [...colorsByUserId].flatMap(([userId, colors]) => {
    const user = TRACE_USERS[userId];
    return user ? [{ color: colors.base, id: userId, name: user.name }] : [];
  });
}

function CombinedTrace({
  activeTurnId,
  detail,
}: {
  activeTurnId: string | null;
  detail: BranchDetail;
}) {
  const colorsByUserId = buildActorColorMap(detail);

  return (
    <section>
      <div className="mb-2">
        <span className={SECTION_TITLE_CLASS}>Combined session trace</span>
      </div>
      <div className="flex flex-col">
        {detail.trace.map((turn) => (
          <TraceTurnView
            active={turn.id === activeTurnId}
            colors={
              colorsByUserId.get(turn.userId) ?? chartColorPairForTokenIndex(0)
            }
            key={turn.id}
            turn={turn}
          />
        ))}
      </div>
    </section>
  );
}

export function BranchSessionsTimeline({ detail }: { detail: BranchDetail }) {
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const clearActiveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projection = projectTimelineCompleteness(detail);

  useEffect(
    () => () => {
      if (clearActiveTimer.current) {
        clearTimeout(clearActiveTimer.current);
      }
    },
    []
  );

  const jumpToTurn = (turnId: string) => {
    const target = document.getElementById(`branch-trace-turn-${turnId}`);
    const scrollContainer = target?.closest<HTMLElement>('[role="tabpanel"]');
    if (target && scrollContainer) {
      const targetRect = target.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();
      const centeredTop =
        scrollContainer.scrollTop +
        targetRect.top -
        containerRect.top -
        (scrollContainer.clientHeight - targetRect.height) / 2;
      scrollContainer.scrollTo({
        behavior: "smooth",
        top: Math.max(0, centeredTop),
      });
    }
    setActiveTurnId(turnId);
    if (clearActiveTimer.current) {
      clearTimeout(clearActiveTimer.current);
    }
    clearActiveTimer.current = setTimeout(() => setActiveTurnId(null), 1400);
  };

  if (detail.sessions.length === 0) {
    return <BranchSessionsEmptyState />;
  }

  return (
    <>
      <div className="sticky top-0 z-10 border-b bg-background">
        <div className="mx-auto w-full max-w-content px-5 py-4">
          <ActivitySection
            detail={detail}
            onJumpToTurn={jumpToTurn}
            projection={projection}
          />
        </div>
      </div>
      <div className="mx-auto w-full max-w-content px-5 pt-6 pb-10">
        <CombinedTrace activeTurnId={activeTurnId} detail={detail} />
      </div>
    </>
  );
}
