"use client";

import { cn } from "@repo/design-system/lib/utils";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TraceTextAnchor } from "./trace-comments";
import { type TraceJumpHandler, TraceMarkdown } from "./trace-markdown";

type TracePart =
  | { kind: "md"; id: number; text: string }
  | { kind: "tag"; id: number; name: string; inner: string };

type TraceRange = { start: number; end: number };

/**
 * Matches Claude Code harness wrapper tags — paired, hyphenated, lowercase tag
 * names like `<command-name>…</command-name>`, `<local-command-caveat>…</…>`,
 * `<system-reminder>…</…>`. The hyphen requirement keeps prose and generics
 * (`Array<string>`) from matching, so only true harness noise is collapsed.
 */
const HARNESS_TAG = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)>([\s\S]*?)<\/\1>/g;
const FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;

function collectRanges(text: string, pattern: RegExp): TraceRange[] {
  const ranges: TraceRange[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }
  return ranges;
}

function isInsideAny(
  ranges: readonly TraceRange[],
  start: number,
  end: number
): boolean {
  return ranges.some((range) => start >= range.start && end <= range.end);
}

function pushMarkdownPart(parts: TracePart[], id: number, text: string): void {
  if (text.trim().length === 0) {
    return;
  }
  parts.push({ kind: "md", id, text });
}

/**
 * Splits message text into markdown spans and collapsible harness-tag blocks,
 * skipping any tag matches that fall inside fenced or inline code.
 */
function parseTraceParts(text: string): TracePart[] {
  const protectedRanges = [
    ...collectRanges(text, FENCE),
    ...collectRanges(text, INLINE_CODE),
  ];
  const parts: TracePart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(HARNESS_TAG)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (isInsideAny(protectedRanges, start, end)) {
      continue;
    }
    pushMarkdownPart(parts, cursor, text.slice(cursor, start));
    parts.push({
      kind: "tag",
      id: start,
      name: match[1],
      inner: match[2].trim(),
    });
    cursor = end;
  }
  pushMarkdownPart(parts, cursor, text.slice(cursor));
  return parts;
}

function TraceTagChip({
  name,
  inner,
  onJump,
}: Readonly<{ name: string; inner: string; onJump?: TraceJumpHandler }>) {
  const [open, setOpen] = useState(false);

  return (
    <div className={cn("st-tag", open && "open")}>
      <button
        aria-expanded={open}
        className="st-tag-head"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? (
          <ChevronDownIcon aria-hidden className="st-tag-chev size-3.5" />
        ) : (
          <ChevronRightIcon aria-hidden className="st-tag-chev size-3.5" />
        )}
        <span className="st-tag-name mono">{name}</span>
      </button>
      {open && inner ? (
        <div className="st-tag-body">
          <TraceMessageBody onJump={onJump} text={inner} />
        </div>
      ) : null}
    </div>
  );
}

type TraceMessageBodyProps = {
  text: string;
  onJump?: TraceJumpHandler;
  className?: string;
  traceActor?: TraceTextAnchor["actor"];
  traceHighlight?:
    | { kind: "exact"; startOffset: number; endOffset: number }
    | { kind: "row" }
    | null;
  traceRow?: number;
  traceSelectionEnabled?: boolean;
  traceSessionId?: string | null;
  traceText?: string;
  traceId?: string;
  traceTurnId?: string;
};

/**
 * Renders a session-trace message body: parsed markdown for prose (preserving
 * `#<row>` jump links) plus collapsible chips for Claude Code harness wrapper
 * tags so they don't dominate the transcript. Falls back to a plain
 * `TraceMarkdown` when no harness tags are present (the common case).
 */
export function TraceMessageBody({
  text,
  onJump,
  className,
  traceActor,
  traceHighlight,
  traceRow,
  traceSelectionEnabled = false,
  traceSessionId,
  traceText = text,
  traceId,
  traceTurnId,
}: Readonly<TraceMessageBodyProps>) {
  const parts = useMemo(() => parseTraceParts(text), [text]);
  const selectionProps = getTraceSelectionProps({
    actor: traceActor,
    enabled: traceSelectionEnabled,
    row: traceRow,
    sessionId: traceSessionId,
    text: traceText,
    traceId,
    turnId: traceTurnId,
  });
  const rowHighlightProps =
    traceHighlight?.kind === "row" ? { "data-trace-highlight": "row" } : {};

  if (traceHighlight?.kind === "exact") {
    return (
      <div
        {...selectionProps}
        {...rowHighlightProps}
        className={cn("st-text", className)}
      >
        <TraceHighlightedMarkdown
          endOffset={traceHighlight.endOffset}
          onJump={onJump}
          startOffset={traceHighlight.startOffset}
          text={text}
        />
      </div>
    );
  }

  if (parts.every((part) => part.kind === "md")) {
    return (
      <div
        {...selectionProps}
        {...rowHighlightProps}
        className={cn("st-text", className)}
      >
        <TraceMarkdown onJump={onJump} text={text} />
      </div>
    );
  }

  return (
    <div
      className={cn("st-text", className)}
      {...selectionProps}
      {...rowHighlightProps}
    >
      {parts.map((part) =>
        part.kind === "tag" ? (
          <TraceTagChip
            inner={part.inner}
            key={`tag-${part.id}-${part.name}`}
            name={part.name}
            onJump={onJump}
          />
        ) : (
          <TraceMarkdown
            key={`md-${part.id}`}
            onJump={onJump}
            text={part.text}
          />
        )
      )}
    </div>
  );
}

function TraceHighlightedMarkdown({
  endOffset,
  onJump,
  startOffset,
  text,
}: {
  endOffset: number;
  onJump?: TraceJumpHandler;
  startOffset: number;
  text: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: text changes rebuild the markdown DOM; rerun to reapply the selected rendered range after that render.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    applyRenderedTextHighlight(root, startOffset, endOffset);
    return () => removeRenderedTextHighlights(root);
  }, [endOffset, startOffset, text]);

  return (
    <div ref={rootRef}>
      <TraceMarkdown className="st-text-fragment" onJump={onJump} text={text} />
    </div>
  );
}

/**
 * Highlights exact trace anchors in rendered markdown coordinates. This keeps
 * the markdown tree intact, avoiding raw delimiter leaks when the selected
 * passage sits inside emphasis, links, or other inline markdown nodes.
 */
function applyRenderedTextHighlight(
  root: HTMLElement,
  startOffset: number,
  endOffset: number
): void {
  removeRenderedTextHighlights(root);
  if (startOffset < 0 || endOffset <= startOffset) {
    return;
  }

  const textNodes = getRenderedTextNodes(root);
  let cursor = 0;
  for (const node of textNodes) {
    const value = node.textContent ?? "";
    const nodeStart = cursor;
    const nodeEnd = cursor + value.length;
    cursor = nodeEnd;

    const highlightStart = Math.max(startOffset, nodeStart);
    const highlightEnd = Math.min(endOffset, nodeEnd);
    if (highlightStart >= highlightEnd) {
      continue;
    }

    const range = root.ownerDocument.createRange();
    range.setStart(node, highlightStart - nodeStart);
    range.setEnd(node, highlightEnd - nodeStart);
    const marker = root.ownerDocument.createElement("span");
    marker.className = "st-selected-passage";
    marker.dataset.traceSelectedPassage = "true";
    range.surroundContents(marker);
  }
}

function removeRenderedTextHighlights(root: HTMLElement): void {
  for (const marker of Array.from(
    root.querySelectorAll<HTMLElement>("[data-trace-selected-passage]")
  )) {
    marker.replaceWith(...Array.from(marker.childNodes));
  }
  root.normalize();
}

function getRenderedTextNodes(root: HTMLElement): Text[] {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT
  );
  const nodes: Text[] = [];
  let next = walker.nextNode();
  while (next) {
    nodes.push(next as Text);
    next = walker.nextNode();
  }
  return nodes;
}

function getTraceSelectionProps({
  actor,
  enabled,
  row,
  sessionId,
  text,
  traceId,
  turnId,
}: {
  actor?: TraceTextAnchor["actor"];
  enabled: boolean;
  row?: number;
  sessionId?: string | null;
  text: string;
  traceId?: string;
  turnId?: string;
}) {
  if (!(enabled && row != null)) {
    return {};
  }
  return {
    "data-trace-actor": actor?.name ?? actor?.human ?? undefined,
    "data-trace-human": actor?.human ?? undefined,
    "data-trace-session-id": sessionId ?? undefined,
    "data-trace-text": text,
    "data-trace-text-row": String(row),
    "data-trace-id": traceId,
    "data-trace-turn-id": turnId,
  };
}
