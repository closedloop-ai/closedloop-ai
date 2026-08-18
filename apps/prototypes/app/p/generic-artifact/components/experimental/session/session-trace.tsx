"use client";

// Prototype-local session presentation pending a separate Sessions review.

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  MessageCircleIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { MentionCommentTextarea } from "../../mention-comment-textarea";
import "./session-trace.css";
import type {
  SessionDetail,
  TraceBlock,
  TraceInline,
  TraceTurn,
} from "./mock-detail";
import {
  buildSessionActorEntries,
  type SessionActorEntry,
  sessionActorId,
} from "./session-actor-colors";

// Bubble tints matching the product's `.st-bubble` blend ratios: a human turn is
// the primary hue at 22% over the background, an agent reply the hue at 5% over
// the card surface.
const agentBubbleBackground = (actor: SessionActorEntry) =>
  `color-mix(in oklch, ${actor.colors.base} 8%, var(--card))`;
const TOOLS_BODY_BG = "color-mix(in oklab, var(--card) 75%, transparent)";

const SECTION_TITLE_CLASS = "font-semibold text-foreground text-sm";

export type TraceCommentAnchor = {
  anchorPreview?: string;
  id: string;
  traceRow: number;
};

export function SessionTrace({
  detail,
  activeTraceRow,
  activeCommentAnchorId,
  activeCommentAnchorNonce,
  commentAnchors = [],
  observeActiveTraceRow = true,
  onActiveTraceRowChange,
  onSubmitTraceComment,
}: {
  detail: SessionDetail;
  activeTraceRow: number;
  activeCommentAnchorId?: string;
  activeCommentAnchorNonce?: number;
  commentAnchors?: TraceCommentAnchor[];
  observeActiveTraceRow?: boolean;
  onActiveTraceRowChange: (row: number) => void;
  onSubmitTraceComment?: (comment: {
    anchorPreview: string;
    body: string;
    traceRow: number;
  }) => void;
}) {
  const traceRef = useRef<HTMLDivElement>(null);
  const [selectionDraft, setSelectionDraft] = useState<{
    anchorPreview: string;
    mode: "affordance" | "composer";
    traceRow: number;
    x: number;
    y: number;
  } | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [scrollHighlightedAnchorId, setScrollHighlightedAnchorId] = useState<
    string | undefined
  >();
  const actorEntries = useMemo(
    () => buildSessionActorEntries(detail),
    [detail]
  );
  const actorById = useMemo(
    () => new Map(actorEntries.map((actor) => [actor.id, actor])),
    [actorEntries]
  );
  useEffect(() => {
    if (!(activeCommentAnchorId && activeCommentAnchorNonce)) {
      return;
    }
    setScrollHighlightedAnchorId(activeCommentAnchorId);
    const timeout = window.setTimeout(
      () => setScrollHighlightedAnchorId(undefined),
      1600
    );
    return () => window.clearTimeout(timeout);
  }, [activeCommentAnchorId, activeCommentAnchorNonce]);
  useEffect(() => {
    if (!observeActiveTraceRow) {
      return;
    }
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
  }, [observeActiveTraceRow, onActiveTraceRowChange]);

  useEffect(() => {
    if (!selectionDraft) {
      return;
    }
    const close = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-comment-control]")
      ) {
        return;
      }
      setSelectionDraft(null);
      setCommentDraft("");
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectionDraft(null);
        setCommentDraft("");
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [selectionDraft]);

  const prepareSelection = () => {
    if (!(onSubmitTraceComment && traceRef.current)) {
      return;
    }
    const selection = globalThis.getSelection?.();
    if (!(selection && selection.rangeCount > 0 && !selection.isCollapsed)) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (!traceRef.current.contains(range.commonAncestorContainer)) {
      return;
    }
    const startElement =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    const endElement =
      range.endContainer instanceof Element
        ? range.endContainer
        : range.endContainer.parentElement;
    const startRow = startElement?.closest<HTMLElement>("[data-trace-row]");
    const endRow = endElement?.closest<HTMLElement>("[data-trace-row]");
    const anchorPreview = selection.toString().trim();
    if (!(startRow && startRow === endRow && anchorPreview)) {
      return;
    }
    const traceRow = Number(startRow.dataset.traceRow);
    if (!Number.isFinite(traceRow)) {
      return;
    }
    const selectionRect = range.getBoundingClientRect();
    const rootRect = traceRef.current.getBoundingClientRect();
    setSelectionDraft({
      anchorPreview,
      mode: "affordance",
      traceRow,
      x: Math.min(
        Math.max(8, selectionRect.left - rootRect.left),
        Math.max(8, rootRect.width - 348)
      ),
      y: Math.max(8, selectionRect.bottom - rootRect.top + 8),
    });
  };

  return (
    <section aria-labelledby="session-trace-heading" data-session-trace>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className={SECTION_TITLE_CLASS} id="session-trace-heading">
          Session Trace
        </h2>
        <span className="text-muted-foreground text-xs">
          {detail.turnCount} {detail.turnCount === 1 ? "turn" : "turns"} ·{" "}
          {detail.toolCount} tool {detail.toolCount === 1 ? "call" : "calls"}
        </span>
      </div>
      {/* Native text selection remains noninteractive; these handlers only
          resolve a completed pointer or keyboard selection into an anchor. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: observes native text selection. */}
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: observes native text selection. */}
      <div
        className="relative flex flex-col"
        onKeyUp={prepareSelection}
        onMouseUp={prepareSelection}
        ref={traceRef}
      >
        {detail.trace.map((turn, index) => (
          <TraceTurnView
            active={(turn.row ?? index) === activeTraceRow}
            activeCommentAnchorId={scrollHighlightedAnchorId}
            actor={
              actorById.get(
                sessionActorId(turn.actorId, turn.actorName, detail.ownerName)
              ) ?? actorEntries[0]
            }
            commentAnchors={commentAnchors.filter(
              (anchor) => anchor.traceRow === (turn.row ?? index)
            )}
            key={turn.id}
            row={turn.row ?? index}
            turn={turn}
          />
        ))}
        {selectionDraft ? (
          <div
            className="absolute z-30"
            data-comment-control
            style={{ left: selectionDraft.x, top: selectionDraft.y }}
          >
            {selectionDraft.mode === "affordance" ? (
              <Button
                className="gap-1.5 border bg-popover text-popover-foreground shadow-lg hover:bg-muted"
                onClick={() =>
                  setSelectionDraft((current) =>
                    current ? { ...current, mode: "composer" } : current
                  )
                }
                size="sm"
                variant="ghost"
              >
                <MessageCircleIcon className="size-3.5" />
                Comment
              </Button>
            ) : (
              <div className="isolate w-[340px] rounded-lg border bg-popover p-3 text-popover-foreground opacity-100 shadow-xl ring-1 ring-border">
                <div className="mb-2 line-clamp-3 border-primary/50 border-l-2 pl-2 text-muted-foreground text-xs">
                  {selectionDraft.anchorPreview}
                </div>
                <MentionCommentTextarea
                  ariaLabel="Comment on selected trace passage"
                  autoFocus
                  className="min-h-20 resize-none text-sm"
                  onChange={setCommentDraft}
                  placeholder="Comment and @mention someone…"
                  value={commentDraft}
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    onClick={() => {
                      setSelectionDraft(null);
                      setCommentDraft("");
                    }}
                    size="sm"
                    variant="outline"
                  >
                    Cancel
                  </Button>
                  <Button
                    disabled={!commentDraft.trim()}
                    onClick={() => {
                      onSubmitTraceComment?.({
                        anchorPreview: selectionDraft.anchorPreview,
                        body: commentDraft.trim(),
                        traceRow: selectionDraft.traceRow,
                      });
                      setSelectionDraft(null);
                      setCommentDraft("");
                      globalThis.getSelection?.()?.removeAllRanges();
                    }}
                    size="sm"
                  >
                    Comment
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function TraceTurnView({
  turn,
  actor,
  row,
  active,
  activeCommentAnchorId,
  commentAnchors,
}: {
  turn: TraceTurn;
  actor: SessionActorEntry;
  row: number;
  active: boolean;
  activeCommentAnchorId?: string;
  commentAnchors: TraceCommentAnchor[];
}) {
  if (turn.kind === "idle") {
    return (
      <div
        className={`relative flex min-h-[4.25rem] scroll-mt-48 items-center py-1 pr-[5.75rem] transition-opacity ${active ? "opacity-100" : "opacity-90"}`}
        data-trace-kind="idle"
        data-trace-row={row}
        id={`session-trace-row-${row}`}
      >
        <div
          className={`flex w-full items-center gap-3 rounded-lg border border-dashed bg-muted/25 px-3 py-2 text-muted-foreground text-xs ${active ? "ring-1 ring-primary/35" : ""}`}
        >
          <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
          <span className="shrink-0">
            Idle between contributing sessions · started {turn.sentLabel} ·{" "}
            {turn.durationLabel}
          </span>
          <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
        </div>
      </div>
    );
  }
  const human = turn.side === "human";
  return (
    <div
      className={`relative flex min-h-[5.75rem] scroll-mt-48 py-1 pr-[6.625rem] transition-opacity ${active ? "opacity-100" : "opacity-90"} ${human ? "justify-end" : "justify-start"}`}
      data-trace-row={row}
      id={`session-trace-row-${row}`}
    >
      <div
        className={`flex w-4/5 flex-col gap-1.5 rounded-xl p-3 ${active ? "ring-1 ring-primary/35" : ""}`}
        style={{
          background: human ? actor.colors.soft : agentBubbleBackground(actor),
        }}
      >
        {turn.blocks.map((block, index) => (
          <TraceBlockView
            activeCommentAnchorId={activeCommentAnchorId}
            block={block}
            commentAnchors={commentAnchors}
            // biome-ignore lint/suspicious/noArrayIndexKey: positional blocks.
            key={index}
          />
        ))}
        {!human && turn.model ? (
          <span className="self-end text-muted-foreground text-xs">
            {turn.model}
          </span>
        ) : null}
      </div>
      <div className="absolute top-0 right-0 flex w-[5.75rem] flex-col items-end gap-1 pt-[0.5625rem]">
        <Avatar
          aria-label={human ? actor.name : `Agent for ${actor.name}`}
          className="size-6"
          title={human ? actor.name : `Agent for ${actor.name}`}
        >
          <AvatarFallback
            className="font-medium text-xs"
            style={{
              background: actor.colors.soft,
              color: actor.colors.strong,
            }}
          >
            {human ? actor.initials || getInitials(actor.name) : "AI"}
          </AvatarFallback>
        </Avatar>
        <div className="flex flex-col items-end">
          {turn.sentLabel ? (
            <span className="whitespace-nowrap text-muted-foreground text-xs tabular-nums leading-normal">
              {turn.sentLabel}
            </span>
          ) : null}
          {!human && turn.durationLabel ? (
            <span className="text-muted-foreground text-xs tabular-nums leading-normal">
              {turn.durationLabel}
            </span>
          ) : null}
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

function TraceBlockView({
  activeCommentAnchorId,
  block,
  commentAnchors,
}: {
  activeCommentAnchorId?: string;
  block: TraceBlock;
  commentAnchors: TraceCommentAnchor[];
}): ReactNode {
  if (block.type === "p") {
    return (
      <p className="text-sm leading-relaxed">
        <TraceSpans
          activeCommentAnchorId={activeCommentAnchorId}
          commentAnchors={commentAnchors}
          spans={block.spans}
        />
      </p>
    );
  }
  if (block.type === "ul") {
    return (
      <ul className="ml-4 flex list-disc flex-col gap-1 text-sm leading-relaxed">
        {block.items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional list items.
          <li key={index}>
            <TraceSpans
              activeCommentAnchorId={activeCommentAnchorId}
              commentAnchors={commentAnchors}
              spans={item}
            />
          </li>
        ))}
      </ul>
    );
  }
  return <TraceTools rows={block.rows} summary={block.summary} />;
}

function TraceSpans({
  activeCommentAnchorId,
  commentAnchors,
  spans,
}: {
  activeCommentAnchorId?: string;
  commentAnchors: TraceCommentAnchor[];
  spans: TraceInline[];
}): ReactNode {
  const text = spans.map(traceInlineText).join("");
  const ranges = commentAnchors.flatMap((anchor) => {
    if (!anchor.anchorPreview) {
      return [];
    }
    const start = text.indexOf(anchor.anchorPreview);
    return start < 0
      ? []
      : [
          {
            active: anchor.id === activeCommentAnchorId,
            end: start + anchor.anchorPreview.length,
            id: anchor.id,
            start,
          },
        ];
  });
  let offset = 0;
  return spans.map((span, index) => {
    const spanText = traceInlineText(span);
    const start = offset;
    offset += spanText.length;
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: positional inline spans.
      <TraceInlineSpan key={index} ranges={ranges} span={span} start={start} />
    );
  });
}

function TraceInlineSpan({
  ranges,
  span,
  start,
}: {
  ranges: Array<{
    active: boolean;
    end: number;
    id: string;
    start: number;
  }>;
  span: TraceInline;
  start: number;
}): ReactNode {
  const text = traceInlineText(span);
  const boundaries = new Set([0, text.length]);
  for (const range of ranges) {
    const localStart = Math.max(0, range.start - start);
    const localEnd = Math.min(text.length, range.end - start);
    if (localStart < localEnd) {
      boundaries.add(localStart);
      boundaries.add(localEnd);
    }
  }
  const points = [...boundaries].sort((a, b) => a - b);
  const content = points.slice(0, -1).map((from, index) => {
    const to = points[index + 1] ?? text.length;
    const value = text.slice(from, to);
    const range = ranges.find(
      (candidate) =>
        candidate.start < start + to && candidate.end > start + from
    );
    return range ? (
      <mark
        className="artifact-selected-text-anchor"
        data-scroll-highlight={range.active ? "true" : undefined}
        key={`${from}-${to}-${range.id}`}
      >
        {value}
      </mark>
    ) : (
      <span key={`${from}-${to}`}>{value}</span>
    );
  });
  if (typeof span === "string") {
    return content;
  }
  if ("code" in span) {
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground text-xs">
        {content}
      </code>
    );
  }
  return <span className="text-primary">{content}</span>;
}

function traceInlineText(span: TraceInline): string {
  if (typeof span === "string") {
    return span;
  }
  if ("code" in span) {
    return span.code;
  }
  return `#${span.pr}`;
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

const initialsSplit = /[\s-]+/;

function getInitials(name: string): string {
  const parts = name.split(initialsSplit).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
