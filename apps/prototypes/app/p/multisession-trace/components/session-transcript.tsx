"use client";

import { cn } from "@repo/design-system/lib/utils";
import { ChevronRightIcon, WorkflowIcon } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import type {
  SubagentRun,
  ToolRow,
  TraceBlock,
  TraceInline,
  TraceTurn,
} from "../mock";

// Bubble tints mirror the product's `.st-bubble` blend ratios: the human turn
// is the primary hue at 22% over the background; the agent reply is a lighter
// hue at 5% over the card.
const HUMAN_BUBBLE_BG =
  "color-mix(in oklab, var(--primary) 22%, var(--background))";
const AGENT_BUBBLE_BG = "color-mix(in oklab, var(--primary) 5%, var(--card))";
const TOOLS_BODY_BG = "color-mix(in oklab, var(--card) 75%, transparent)";

function InlineSpan({ span }: { span: TraceInline }): ReactNode {
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
  return (
    <a
      className="text-primary hover:underline"
      href={span.url}
      rel="noreferrer"
      target="_blank"
    >
      #{span.pr}
    </a>
  );
}

function Spans({ spans }: { spans: TraceInline[] }): ReactNode {
  return spans.map((span, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: positional inline spans.
    <InlineSpan key={index} span={span} />
  ));
}

function ToolRowsBody({ rows }: { rows: ToolRow[] }) {
  return (
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
  );
}

function ToolsDisclosure({
  summary,
  rows,
}: {
  summary: string;
  rows: ToolRow[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 py-1 text-left text-muted-foreground text-xs hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-200",
            open && "rotate-90"
          )}
        />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
      </button>
      {open ? <ToolRowsBody rows={rows} /> : null}
    </div>
  );
}

/**
 * A collapsed sub-agent inside a session transcript — the FEA-4172 idiom that
 * already shipped for the single-session case, reused verbatim here so an
 * expanded session's own sub-agent work stays collapsed by default.
 */
function SubagentDisclosure({ run }: { run: SubagentRun }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2 bg-muted/40 px-2.5 py-1.5 text-left text-sm hover:bg-muted/60"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-90"
          )}
        />
        <WorkflowIcon aria-hidden className="size-3.5 shrink-0 opacity-60" />
        <span className="min-w-0 flex-1">
          <span className="truncate font-medium">{run.name}</span>
          <span className="ml-2 text-muted-foreground text-xs">
            {run.description}
          </span>
        </span>
        <span className="shrink-0 font-medium text-[11px] text-muted-foreground tabular-nums">
          {run.steps.length} {run.steps.length === 1 ? "step" : "steps"}
        </span>
      </button>
      {open ? (
        <div className="px-2 py-1.5">
          <ToolRowsBody rows={run.steps} />
        </div>
      ) : null}
    </div>
  );
}

function BlockView({ block }: { block: TraceBlock }): ReactNode {
  if (block.type === "p") {
    return (
      <p className="text-sm leading-relaxed">
        <Spans spans={block.spans} />
      </p>
    );
  }
  if (block.type === "ul") {
    return (
      <ul className="ml-4 flex list-disc flex-col gap-1 text-sm leading-relaxed">
        {block.items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional list items.
          <li key={index}>
            <Spans spans={item} />
          </li>
        ))}
      </ul>
    );
  }
  if (block.type === "subagent") {
    return <SubagentDisclosure run={block.run} />;
  }
  return <ToolsDisclosure rows={block.rows} summary={block.summary} />;
}

function TurnView({ turn }: { turn: TraceTurn }) {
  const human = turn.side === "human";
  return (
    <div className={cn("flex py-1", human ? "justify-end" : "justify-start")}>
      <div
        className="flex w-4/5 flex-col gap-1.5 rounded-xl px-3 py-2"
        style={{ background: human ? HUMAN_BUBBLE_BG : AGENT_BUBBLE_BG }}
      >
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{human ? "You" : (turn.model ?? "agent")}</span>
          <span>{turn.timeLabel}</span>
        </div>
        {turn.blocks.map((block, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional blocks.
          <BlockView block={block} key={index} />
        ))}
      </div>
    </div>
  );
}

export function SessionTranscript({ turns }: { turns: TraceTurn[] }) {
  return (
    <div className="flex flex-col">
      {turns.map((turn) => (
        <Fragment key={turn.id}>
          <TurnView turn={turn} />
        </Fragment>
      ))}
    </div>
  );
}
