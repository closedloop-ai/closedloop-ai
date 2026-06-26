"use client";

import { cn } from "@repo/design-system/lib/utils";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";
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
}: Readonly<TraceMessageBodyProps>) {
  const parts = parseTraceParts(text);

  if (parts.every((part) => part.kind === "md")) {
    return (
      <TraceMarkdown
        className={cn("st-text", className)}
        onJump={onJump}
        text={text}
      />
    );
  }

  return (
    <div className={cn("st-text", className)}>
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
