"use client";

import type { TurnActor, TurnItem } from "@repo/api/src/types/agent-session";
import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";
import { cn } from "@repo/design-system/lib/utils";
import {
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { TraceMessageBody } from "./trace-message-body";

export type SessionTraceProps = {
  items: readonly SessionTraceItem[];
  activeRow?: number | null;
  onJump?: (row: number) => void;
  className?: string;
};

export type SessionTraceItem = TurnItem & {
  flag?: {
    reason?: string | null;
  } | null;
};

type TraceMessageSide = "agent" | "human";

type TraceMessageItem = Extract<
  SessionTraceItem,
  { type: "prompt" | "say" | "tools" | "subagent" }
>;

type TraceMessageSegment =
  | { type: "text"; text: string; row: number }
  | { type: "tools"; item: Extract<TurnItem, { type: "tools" }> }
  | { type: "subagent"; item: Extract<TurnItem, { type: "subagent" }> };

type TraceGroup =
  | {
      kind: "msg";
      side: TraceMessageSide;
      sessionId?: string | null;
      actor: TurnActor;
      startLabel?: string | null;
      startMs?: number | null;
      endMs?: number | null;
      cumulativeCost?: number | null;
      model?: string | null;
      row: number;
      flagReason?: string | null;
      segments: TraceMessageSegment[];
    }
  | {
      kind: "reason";
      actor: TurnActor;
      sessionId?: string | null;
      startLabel?: string | null;
      startMs?: number | null;
      model?: string | null;
      row: number;
      text: string;
    }
  | {
      kind: "event";
      item: Extract<TurnItem, { type: "event" }>;
      row: number;
    }
  | {
      kind: "end";
      item: Extract<TurnItem, { type: "end" }>;
    };

type TraceSayItem = Extract<SessionTraceItem, { type: "say" }>;

const TRACE_LINK_PATTERN = /(#\d+)/g;

/**
 * Renders coalesced Session Trace turns: prompt/say/tool/subagent bubbles,
 * system event rows, and terminal rows. Tool and subagent blocks are native
 * buttons so browser keyboard activation works without custom handlers.
 */
export function SessionTrace({
  items,
  activeRow,
  onJump,
  className,
}: Readonly<SessionTraceProps>) {
  const groups = useMemo(() => buildTraceGroups(items), [items]);

  return (
    <div className={cn("st", className)}>
      {groups.map((group) => {
        if (group.kind === "event") {
          return (
            <TraceEventRow
              active={group.row === activeRow}
              group={group}
              key={getTraceGroupKey(group)}
              onJump={onJump}
            />
          );
        }
        if (group.kind === "end") {
          return (
            <div className="st-end" key={getTraceGroupKey(group)}>
              <CircleCheckIcon
                aria-hidden
                className="size-3.5 text-success-foreground"
              />
              {group.item.text}
            </div>
          );
        }
        if (group.kind === "reason") {
          return (
            <TraceReasonRow
              active={group.row === activeRow}
              group={group}
              key={getTraceGroupKey(group)}
              onJump={onJump}
            />
          );
        }
        return (
          <TraceMessageRow
            activeRow={activeRow}
            group={group}
            key={getTraceGroupKey(group)}
            onJump={onJump}
          />
        );
      })}
    </div>
  );
}

function TraceMessageRow({
  activeRow,
  group,
  onJump,
}: Readonly<{
  activeRow?: number | null;
  group: Extract<TraceGroup, { kind: "msg" }>;
  onJump?: (row: number) => void;
}>) {
  const human = group.side === "human";
  const active = traceGroupContainsRow(group, activeRow);
  const tone = getBubbleTone(human);
  // Show how long the coalesced AGENT turn took (last item − first item) under
  // the start time, rather than a second wall-clock stamp. Human groups have no
  // execution duration, so they keep just the timestamp. Sub-second spans (e.g.
  // a lone text bubble) are omitted so single-item rows show one timestamp only.
  const durationMs =
    !human && group.startMs != null && group.endMs != null
      ? group.endMs - group.startMs
      : null;
  const durationLabel =
    durationMs != null && durationMs >= 1000
      ? formatDurationMs(durationMs)
      : null;
  const startLabel =
    group.startMs == null ? group.startLabel : formatTraceClock(group.startMs);
  const cost =
    group.cumulativeCost != null && group.cumulativeCost > 0
      ? formatTraceCost(group.cumulativeCost)
      : null;

  return (
    <div
      className={cn("st-msg", human ? "right" : "left")}
      data-active={active ? "true" : undefined}
      data-row={group.row}
    >
      <div
        className={cn(
          "st-bubble",
          group.flagReason && "st-flagged",
          tone.className
        )}
      >
        {group.flagReason ? (
          <div className="st-flag-tag">{group.flagReason}</div>
        ) : null}
        {group.segments.map((segment) => {
          if (segment.type === "tools") {
            return (
              <SessionTraceTools
                item={segment.item}
                key={`tools-${segment.item._row}`}
              />
            );
          }
          if (segment.type === "subagent") {
            return (
              <SessionTraceSubagent
                item={segment.item}
                key={`subagent-${segment.item._row}`}
              />
            );
          }
          return (
            <TraceMessageBody
              key={`text-${segment.row}`}
              onJump={onJump}
              text={segment.text}
            />
          );
        })}
        {!human && group.model ? (
          <div className="st-model mono">{group.model}</div>
        ) : null}
      </div>
      <div className="st-gut">
        <span className="st-gut-line">{startLabel ?? ""}</span>
        <span className="st-gut-bot">
          {durationLabel ? (
            <span className="st-gut-line">{durationLabel}</span>
          ) : null}
          {cost ? <span className="st-gut-line cost">{cost}</span> : null}
        </span>
      </div>
    </div>
  );
}

function TraceReasonRow({
  active,
  group,
  onJump,
}: Readonly<{
  active?: boolean;
  group: Extract<TraceGroup, { kind: "reason" }>;
  onJump?: (row: number) => void;
}>) {
  const [open, setOpen] = useState(true);
  const startLabel =
    group.startMs == null ? group.startLabel : formatTraceClock(group.startMs);

  return (
    <div
      className="st-msg left"
      data-active={active ? "true" : undefined}
      data-row={group.row}
    >
      <div className="st-bubble st-reason p-agent">
        <button
          aria-expanded={open}
          className="st-reason-head"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          <BrainIcon aria-hidden className="size-3.5" />
          <span className="st-reason-label">Reasoning</span>
          {open ? (
            <ChevronDownIcon aria-hidden className="st-reason-chev size-3.5" />
          ) : (
            <ChevronRightIcon aria-hidden className="st-reason-chev size-3.5" />
          )}
        </button>
        {open ? <TraceMessageBody onJump={onJump} text={group.text} /> : null}
        {group.model ? (
          <div className="st-model mono">{group.model}</div>
        ) : null}
      </div>
      <div className="st-gut">
        <span className="st-gut-line">{startLabel ?? ""}</span>
      </div>
    </div>
  );
}

function SessionTraceTools({
  item,
}: Readonly<{ item: Extract<TurnItem, { type: "tools" }> }>) {
  // A card with no per-tool rows (degraded trace) renders as a static summary,
  // never a dropdown that opens to nothing. Derive expandability from the raw
  // item so the per-row keys are built only when the body is actually shown.
  const expandable = item.items.length > 0;
  const [open, setOpen] = useState(Boolean(item.defaultOpen || item.hasFail));
  const ToolsChevron = open ? ChevronDownIcon : ChevronRightIcon;

  const summary = (
    <>
      {item.hasFail ? <span aria-hidden className="st-sys-dot d-r" /> : null}
      <span className="st-tools-summary">{item.summary}</span>
      {item.hasFail ? (
        <span className="st-fail-pill">
          <TriangleAlertIcon aria-hidden className="size-2.5" />
          {item.failN || 1} failed
        </span>
      ) : null}
      {/* Only the expandable variant carries a chevron — a card with no per-tool
          rows (degraded trace) renders as a static summary, never a dropdown
          that opens to nothing. */}
      {expandable ? (
        <ToolsChevron aria-hidden className="st-tools-chev size-3.5" />
      ) : null}
    </>
  );

  return (
    <div
      className={cn(
        "st-tools",
        expandable && open && "open",
        item.hasFail && "has-fail"
      )}
      data-row={item._row}
    >
      {expandable ? (
        <button
          aria-expanded={open}
          className="st-tools-head"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          {summary}
        </button>
      ) : (
        <div className="st-tools-head st-tools-head-static">{summary}</div>
      )}
      {expandable && open ? (
        <div className="st-tools-body">
          {buildTraceToolRows(item.items).map(({ key, tool }) => (
            <div className={cn("st-toolrow", tool.err && "err")} key={key}>
              <span className={cn("st-tool-label mono")}>{tool.label}</span>
              {tool.detail ? (
                <span className="st-tool-detail">{tool.detail}</span>
              ) : null}
              <ChevronRightIcon
                aria-hidden
                className="st-toolrow-chev size-3"
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SessionTraceSubagent({
  item,
}: Readonly<{ item: Extract<TurnItem, { type: "subagent" }> }>) {
  const [open, setOpen] = useState(false);
  const meta = [item.model, item.duration, item.tokens, item.cost].filter(
    Boolean
  );
  const bodyLines = buildSubagentBodyLines(item.body);

  return (
    <div className="st-sub">
      <button
        aria-expanded={open}
        className="st-sub-head"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="st-sub-sum">Subagent | {item.sub}</span>
        {meta.length > 0 ? (
          <span className="st-sub-meta mono">{meta.join(" | ")}</span>
        ) : null}
        {open ? (
          <ChevronDownIcon aria-hidden className="st-sub-chev size-3.5" />
        ) : (
          <ChevronRightIcon aria-hidden className="st-sub-chev size-3.5" />
        )}
      </button>
      {open ? (
        <div className="st-sub-body">
          <div className="st-sub-info mono">
            {[
              item.sub,
              item.model,
              item.duration ? `ran ${item.duration}` : null,
              item.tokens,
              item.cost,
            ]
              .filter(Boolean)
              .join(" | ")}
          </div>
          {item.body.length === 0 ? (
            <div className="st-sub-empty">No transcript captured.</div>
          ) : (
            bodyLines.map(({ key, line }) => (
              <SubagentBodyLine key={key} line={line} />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function SubagentBodyLine({
  line,
}: Readonly<{
  line: Extract<TurnItem, { type: "subagent" }>["body"][number];
}>) {
  const className = `st-sub-ln k-${getSubagentLineKindClassName(line.kind)}`;
  return (
    <div className={cn(className, line.err && "text-destructive")}>
      {line.kind === "tool" ? (
        <span className="st-sub-ln-t mono">{line.text}</span>
      ) : (
        <span className="st-sub-ln-x">{line.text}</span>
      )}
    </div>
  );
}

function TraceEventRow({
  active,
  group,
  onJump,
}: Readonly<{
  active?: boolean;
  group: Extract<TraceGroup, { kind: "event" }>;
  onJump?: (row: number) => void;
}>) {
  const dotClassName = getEventDotClassName(group.item.dot);
  const clickable = Boolean(onJump);
  const content = (
    <>
      {dotClassName ? (
        <span aria-hidden className={cn("st-sys-dot", dotClassName)} />
      ) : null}
      <span className="st-sysline-text">
        {renderTraceLinks(group.item.text)}
      </span>
      <span className="st-time">{formatTraceTimestamp(group.item.t)}</span>
    </>
  );

  if (!clickable) {
    return (
      <div
        className="st-sysline"
        data-active={active ? "true" : undefined}
        data-row={group.row}
      >
        {content}
      </div>
    );
  }

  return (
    <button
      className="st-sysline w-full border-0 bg-transparent"
      data-active={active ? "true" : undefined}
      data-row={group.row}
      onClick={() => onJump?.(group.row)}
      type="button"
    >
      {content}
    </button>
  );
}

function buildTraceGroups(items: readonly SessionTraceItem[]): TraceGroup[] {
  const groups: TraceGroup[] = [];
  let current: Extract<TraceGroup, { kind: "msg" }> | null = null;

  for (const item of items) {
    if (!item || item.type === "idle" || item.type === "sessionstart") {
      continue;
    }
    if (item.type === "event") {
      current = flushTraceMessageGroup(groups, current);
      groups.push({
        kind: "event",
        item,
        row: item._row,
      });
      continue;
    }
    if (item.type === "end") {
      current = flushTraceMessageGroup(groups, current);
      groups.push({ kind: "end", item });
      continue;
    }

    // Reasoning turns render as their own distinct bubble, never coalesced with
    // response text. Redacted/empty reasoning markers carry no content (Claude
    // redacts thinking text) so they are dropped as noise.
    if (item.type === "say" && item.isThinking) {
      if (item.text.trim().length === 0) {
        continue;
      }
      current = flushTraceMessageGroup(groups, current);
      groups.push(createTraceReasonGroup(item));
      continue;
    }

    // Drop whitespace-only prompt/say turns so they don't render empty bubbles.
    if (isBlankTextItem(item)) {
      continue;
    }

    if (canAppendTraceItem(current, item)) {
      current = appendTraceItem(current, item);
      continue;
    }

    current = flushTraceMessageGroup(groups, current);
    current = createTraceMessageGroup(item);
  }
  flushTraceMessageGroup(groups, current);
  return groups;
}

function flushTraceMessageGroup(
  groups: TraceGroup[],
  group: Extract<TraceGroup, { kind: "msg" }> | null
): null {
  if (group) {
    groups.push(group);
  }
  return null;
}

function canAppendTraceItem(
  group: Extract<TraceGroup, { kind: "msg" }> | null,
  item: TraceMessageItem
): group is Extract<TraceGroup, { kind: "msg" }> {
  return (
    group !== null &&
    group.side === getMessageSide(item) &&
    group.sessionId === item.actor.sessionId
  );
}

function appendTraceItem(
  group: Extract<TraceGroup, { kind: "msg" }>,
  item: TraceMessageItem
): Extract<TraceGroup, { kind: "msg" }> {
  return {
    ...group,
    cumulativeCost: item.cum,
    endMs: maxMaybe(group.endMs, getSegmentEndMs(item)),
    flagReason: group.flagReason ?? item.flag?.reason ?? null,
    model: getItemModel(item) ?? group.model ?? null,
    segments: [...group.segments, toMessageSegment(item)],
  };
}

function createTraceMessageGroup(
  item: TraceMessageItem
): Extract<TraceGroup, { kind: "msg" }> {
  return {
    kind: "msg",
    side: getMessageSide(item),
    sessionId: item.actor.sessionId,
    actor: item.actor,
    startLabel: formatTraceTimestamp(item.t),
    startMs: item.tMs,
    endMs: getSegmentEndMs(item),
    cumulativeCost: item.cum,
    model: getItemModel(item),
    row: item._row,
    flagReason: item.flag?.reason ?? null,
    segments: [toMessageSegment(item)],
  };
}

function createTraceReasonGroup(
  item: TraceSayItem
): Extract<TraceGroup, { kind: "reason" }> {
  return {
    kind: "reason",
    actor: item.actor,
    sessionId: item.actor.sessionId,
    startLabel: formatTraceTimestamp(item.t),
    startMs: item.tMs,
    model: item.model ?? null,
    row: item._row,
    text: item.text,
  };
}

function getItemModel(item: TraceMessageItem): string | null {
  return item.type === "say" ? (item.model ?? null) : null;
}

function isBlankTextItem(item: TraceMessageItem): boolean {
  return (
    (item.type === "prompt" || item.type === "say") &&
    item.text.trim().length === 0
  );
}

function getMessageSide(item: TraceMessageItem): TraceMessageSide {
  if (item.type === "prompt") {
    return "human";
  }
  return "agent";
}

function toMessageSegment(item: TraceMessageItem): TraceMessageSegment {
  if (item.type === "tools") {
    return { type: "tools", item };
  }
  if (item.type === "subagent") {
    return { type: "subagent", item };
  }
  return {
    type: "text",
    text: item.text,
    row: item._row,
  };
}

function getSegmentEndMs(item: TraceMessageItem): number | null {
  if (item.type === "tools") {
    return item.endMs;
  }
  return item.tMs;
}

function maxMaybe(
  left: number | null | undefined,
  right: number | null | undefined
): number | null {
  if (left == null) {
    return right ?? null;
  }
  if (right == null) {
    return left;
  }
  return Math.max(left, right);
}

function getBubbleTone(human: boolean): { className: string } {
  return {
    className: human ? "p-human" : "p-agent",
  };
}

function getEventDotClassName(dot: "b" | "g" | "r"): string | null {
  if (dot === "g") {
    return "d-g";
  }
  if (dot === "r") {
    return "d-r";
  }
  return null;
}

function getSubagentLineKindClassName(kind: string): string {
  if (kind === "task") {
    return "task";
  }
  if (kind === "tool") {
    return "tool";
  }
  if (kind === "status") {
    return "status";
  }
  return "say";
}

function traceGroupContainsRow(
  group: Extract<TraceGroup, { kind: "msg" }>,
  row: number | null | undefined
): boolean {
  if (row == null) {
    return false;
  }
  if (group.row === row) {
    return true;
  }
  return group.segments.some((segment) => getSegmentRow(segment) === row);
}

function getSegmentRow(segment: TraceMessageSegment): number | null {
  if (segment.type === "text") {
    return segment.row;
  }
  return segment.item._row;
}

function renderTraceLinks(
  text: string,
  onJump?: (row: number) => void
): ReactNode {
  if (!onJump) {
    return text;
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TRACE_LINK_PATTERN)) {
    const part = match[0];
    const matchIndex = match.index;
    if (matchIndex > cursor) {
      parts.push(text.slice(cursor, matchIndex));
    }
    const row = Number(part.slice(1));
    parts.push(
      <button
        className="st-link inline border-0 bg-transparent p-0 font-[inherit]"
        key={`${part}-${matchIndex}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (Number.isFinite(row)) {
            onJump?.(row);
          }
        }}
        type="button"
      >
        {part}
      </button>
    );
    cursor = matchIndex + part.length;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts.length > 0 ? parts : text;
}

function buildTraceToolRows(
  tools: Extract<TurnItem, { type: "tools" }>["items"]
): TraceToolRow[] {
  const keyCounts = new Map<string, number>();
  return tools.map((tool) => {
    const baseKey = `${tool.label}-${tool.detail}-${tool.err ? "error" : "ok"}`;
    return {
      key: getTraceOccurrenceKey(baseKey, keyCounts),
      tool,
    };
  });
}

function buildSubagentBodyLines(
  body: Extract<TurnItem, { type: "subagent" }>["body"]
): SubagentBodyLineRow[] {
  const keyCounts = new Map<string, number>();
  return body.map((line) => {
    const baseKey = `${line.kind}-${line.t ?? "no-time"}-${line.text}`;
    return {
      key: getTraceOccurrenceKey(baseKey, keyCounts),
      line,
    };
  });
}

function getTraceOccurrenceKey(
  baseKey: string,
  keyCounts: Map<string, number>
): string {
  const occurrence = keyCounts.get(baseKey) ?? 0;
  keyCounts.set(baseKey, occurrence + 1);
  return `${baseKey}-${occurrence}`;
}

type TraceToolRow = {
  key: string;
  tool: Extract<TurnItem, { type: "tools" }>["items"][number];
};

type SubagentBodyLineRow = {
  key: string;
  line: Extract<TurnItem, { type: "subagent" }>["body"][number];
};

function getTraceGroupKey(group: TraceGroup): string {
  if (group.kind === "event") {
    return `event-${group.row}`;
  }
  if (group.kind === "end") {
    return `end-${group.item.text}`;
  }
  if (group.kind === "reason") {
    return `reason-${group.row}`;
  }
  return `msg-${group.row}`;
}

function formatTraceClock(ms: number): string | null {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  let hours = date.getHours();
  const suffix = hours < 12 ? "am" : "pm";
  hours = hours % 12 || 12;
  const minutes = date.getMinutes();
  return `${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}${suffix}`;
}

function formatTraceTimestamp(value: string | Date): string {
  if (value instanceof Date) {
    return formatTraceClock(value.getTime()) ?? "";
  }
  const ms = Date.parse(value);
  if (Number.isFinite(ms)) {
    return formatTraceClock(ms) ?? value;
  }
  return value;
}

function formatTraceCost(value: number): string {
  return `$${value.toFixed(2)}`;
}
