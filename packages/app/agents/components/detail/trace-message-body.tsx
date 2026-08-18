"use client";

import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { TraceTextAnchor } from "./trace-comments";
import type { TracePart } from "./trace-harness-tags";
import {
  parseTraceParts,
  renderCommandPart,
  TraceTagChip,
} from "./trace-harness-tags";
import { type TraceJumpHandler, TraceMarkdown } from "./trace-markdown";

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
      {parts.map((part) => renderMessageBodyPart(part, onJump))}
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

/**
 * Renders a collapsed harness tag's inner content the message-row way: recurse
 * through `TraceMessageBody` so nested markdown, links, and nested harness tags
 * all fold correctly. Passed to `TraceTagChip` as its `renderInner`.
 */
function renderMessageBodyInner(
  inner: string,
  onJump?: TraceJumpHandler
): ReactNode {
  return <TraceMessageBody onJump={onJump} text={inner} />;
}

/**
 * Renders one folded trace part. ISS-4767 added the `command` part — a whole
 * slash-command invocation folded into a single chip — alongside the generic
 * harness-wrapper chip and plain markdown.
 */
function renderMessageBodyPart(
  part: TracePart,
  onJump?: TraceJumpHandler
): ReactNode {
  if (part.kind === "command") {
    return renderCommandPart(part, onJump, renderMessageBodyInner);
  }
  if (part.kind === "tag") {
    return (
      <TraceTagChip
        inner={part.inner}
        key={`tag-${part.id}-${part.name}`}
        name={part.name}
        onJump={onJump}
        renderInner={renderMessageBodyInner}
      />
    );
  }
  return (
    <TraceMarkdown key={`md-${part.id}`} onJump={onJump} text={part.text} />
  );
}
