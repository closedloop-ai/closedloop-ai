"use client";

// Faithful copy of the Combined session trace transcript from the branches
// prototype's sessions-timeline (the flow owner, `app/p/branches`). Duplicated
// rather than imported because the originals are module-private there. No
// behavioral changes — the degraded states live in sessions-timeline-degraded,
// which decides WHAT trace (if any) this renders.

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import {
  type ChartColorPair,
  chartColorPairForTokenIndex,
} from "@repo/design-system/components/ui/chart-colors";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  type BranchDetail,
  TRACE_USERS,
  type TraceBlock,
  type TraceInline,
  type TraceTurn,
} from "@/app/p/branches/mock";

const agentBubbleBg = (colors: ChartColorPair) =>
  `color-mix(in oklch, ${colors.base} 8%, var(--card))`;
const TOOLS_BODY_BG = "color-mix(in oklab, var(--card) 75%, transparent)";

// The approved two-actor trace treatment uses the palette's canonical blue and
// orange slots. Models and CI helpers are execution metadata, not chart actors.
const TRACE_ACTOR_COLOR_INDEXES = [0, 4] as const;

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
export function buildActorColorMap(
  detail: BranchDetail
): Map<string, ChartColorPair> {
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

export function traceActorEntries(
  detail: BranchDetail
): { color: string; id: string; name: string }[] {
  const colorsByUserId = buildActorColorMap(detail);
  return [...colorsByUserId].flatMap(([userId, colors]) => {
    const user = TRACE_USERS[userId];
    return user ? [{ color: colors.base, id: userId, name: user.name }] : [];
  });
}

export function CombinedTrace({
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
        <span className="font-semibold text-foreground text-sm">
          Combined session trace
        </span>
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
