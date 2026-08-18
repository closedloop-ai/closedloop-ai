"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type {
  SessionDetail,
  TraceBlock,
  TraceInline,
  TraceTurn,
} from "../mock-detail";
import { getInitials } from "./session-cells";

// Bubble tints matching the product's `.st-bubble` blend ratios: a human turn is
// the primary hue at 22% over the background, an agent reply the hue at 5% over
// the card surface.
const HUMAN_BUBBLE_BG =
  "color-mix(in oklab, var(--primary) 22%, var(--background))";
const AGENT_BUBBLE_BG = "color-mix(in oklab, var(--primary) 5%, var(--card))";
const AVATAR_BG = "color-mix(in oklab, var(--primary) 22%, var(--background))";
const TOOLS_BODY_BG = "color-mix(in oklab, var(--card) 75%, transparent)";

const SECTION_TITLE_CLASS = "font-semibold text-foreground text-sm";

export function SessionTrace({
  detail,
  activeTraceRow,
  onActiveTraceRowChange,
}: {
  detail: SessionDetail;
  activeTraceRow: number;
  onActiveTraceRowChange: (row: number) => void;
}) {
  const traceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = traceRef.current?.closest<HTMLElement>(
      "[data-session-detail-scroll]"
    );
    if (!(root && traceRef.current)) {
      return;
    }
    const intersecting = new Map<Element, DOMRectReadOnly>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            intersecting.set(entry.target, entry.boundingClientRect);
          } else {
            intersecting.delete(entry.target);
          }
        }
        const topmost = [...intersecting.entries()].sort(
          ([, a], [, b]) => a.top - b.top
        )[0]?.[0];
        const row = topmost?.getAttribute("data-trace-row");
        if (row != null) {
          onActiveTraceRowChange(Number(row));
        }
      },
      { root, rootMargin: "-180px 0px -55% 0px", threshold: 0.1 }
    );
    for (const node of traceRef.current.querySelectorAll("[data-trace-row]")) {
      observer.observe(node);
    }
    return () => observer.disconnect();
  }, [onActiveTraceRowChange]);
  return (
    <section aria-labelledby="session-trace-heading">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className={SECTION_TITLE_CLASS} id="session-trace-heading">
          Session Trace
        </h2>
        <span className="text-muted-foreground text-xs">
          {detail.turnCount} {detail.turnCount === 1 ? "turn" : "turns"} ·{" "}
          {detail.toolCount} tool {detail.toolCount === 1 ? "call" : "calls"}
        </span>
      </div>
      <div className="relative flex flex-col" ref={traceRef}>
        {detail.trace.map((turn, index) => (
          <TraceTurnView
            active={(turn.row ?? index) === activeTraceRow}
            key={turn.id}
            ownerName={detail.ownerName}
            row={turn.row ?? index}
            turn={turn}
          />
        ))}
      </div>
    </section>
  );
}

function TraceTurnView({
  turn,
  ownerName,
  row,
  active,
}: {
  turn: TraceTurn;
  ownerName: string;
  row: number;
  active: boolean;
}) {
  const human = turn.side === "human";
  return (
    <div
      className={`relative flex min-h-[5.75rem] scroll-mt-48 py-1 pr-[5.75rem] transition-opacity ${active ? "opacity-100" : "opacity-90"} ${human ? "justify-end" : "justify-start"}`}
      data-trace-row={row}
      id={`session-trace-row-${row}`}
    >
      <div
        className={`flex w-4/5 flex-col gap-1.5 rounded-xl p-3 ${active ? "ring-1 ring-primary/35" : ""}`}
        style={{ background: human ? HUMAN_BUBBLE_BG : AGENT_BUBBLE_BG }}
      >
        {turn.blocks.map((block, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional blocks.
          <TraceBlockView block={block} key={index} />
        ))}
        {!human && turn.model ? (
          <span className="self-end text-muted-foreground text-xs">
            {turn.model}
          </span>
        ) : null}
      </div>
      <div className="absolute top-0 right-0 flex w-[4.875rem] flex-col items-end gap-1 pt-[0.5625rem]">
        <Avatar
          aria-label={human ? ownerName : "Agent"}
          className="size-6"
          title={human ? ownerName : "Agent"}
        >
          <AvatarFallback
            className="font-medium text-xs"
            style={{ background: AVATAR_BG, color: "var(--primary)" }}
          >
            {human ? getInitials(ownerName) : "AI"}
          </AvatarFallback>
        </Avatar>
        <div className="flex flex-col items-end">
          {turn.sentLabel ? (
            <span className="text-muted-foreground text-xs leading-normal">
              {turn.sentLabel}
            </span>
          ) : null}
          <span className="text-muted-foreground text-xs leading-normal">
            {turn.timeLabel}
          </span>
          {turn.costLabel ? (
            <span className="text-muted-foreground text-xs tabular-nums leading-normal">
              {turn.costLabel}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TraceBlockView({ block }: { block: TraceBlock }): ReactNode {
  if (block.type === "p") {
    return (
      <p className="text-sm leading-relaxed">
        <TraceSpans spans={block.spans} />
      </p>
    );
  }
  if (block.type === "ul") {
    return (
      <ul className="ml-4 flex list-disc flex-col gap-1 text-sm leading-relaxed">
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

function TraceSpans({ spans }: { spans: TraceInline[] }): ReactNode {
  return spans.map((span, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: positional inline spans.
    <TraceInlineSpan key={index} span={span} />
  ));
}

function TraceInlineSpan({ span }: { span: TraceInline }): ReactNode {
  if (typeof span === "string") {
    return span;
  }
  if ("code" in span) {
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground text-xs">
        {span.code}
      </code>
    );
  }
  return <span className="text-primary">#{span.pr}</span>;
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
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-muted-foreground text-xs hover:text-foreground"
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
