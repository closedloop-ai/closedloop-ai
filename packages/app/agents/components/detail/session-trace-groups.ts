import type {
  TranscriptTurnIdentity,
  TurnActor,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { classifyTraceExtentRejection } from "@repo/lib/branches/merged-trace";
import {
  formatTraceCostPrecise,
  formatTraceCostUsd,
} from "@repo/lib/sessions/trace-cost-format";
import type { TraceEventGroup } from "./trace-event-row";
import { getTraceOccurrenceKey } from "./trace-occurrence-key";
import { formatTraceTimestamp } from "./trace-row-utils";

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
  | {
      type: "text";
      text: string;
      row: number;
      traceId: string;
      turnId: string;
      transcriptIdentity?: TranscriptTurnIdentity;
    }
  | { type: "tools"; item: Extract<TurnItem, { type: "tools" }> }
  | { type: "subagent"; item: Extract<TurnItem, { type: "subagent" }> };

export type TraceGroup =
  | {
      kind: "msg";
      side: TraceMessageSide;
      sessionId?: string | null;
      actor: TurnActor;
      startLabel?: string | null;
      startMs?: number | null;
      endMs?: number | null;
      cumulativeCost?: number | null;
      costDelta?: number;
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
      traceId: string;
      turnId: string;
      text: string;
      transcriptIdentity?: TranscriptTurnIdentity;
    }
  | TraceEventGroup
  | {
      kind: "idle";
      /** Wall-clock span the pause covers; the row's whole timing statement. */
      gapMs: number;
      /** Position among the trace's idle spans — a rowless group's stable key. */
      ordinal: number;
    }
  | {
      kind: "end";
      item: Extract<TurnItem, { type: "end" }>;
    };

type TraceSayItem = Extract<SessionTraceItem, { type: "say" }>;

/**
 * The trace's groups WITHOUT idle rows: an `idle` turn item is dropped, exactly
 * as it was before ISS-8652. This is the shape every caller with no flag
 * provider gets — Storybook, unit tests, and the closed gate.
 */
export function buildTraceGroups(
  items: readonly SessionTraceItem[]
): TraceGroup[] {
  return collectTraceGroups(items, false);
}

/**
 * The trace's groups WITH idle rows (ISS-8652): a pause between two stamped
 * items becomes its own group carrying the span it covers.
 *
 * A separate entry point rather than a boolean parameter, because the flag must
 * be read once and swapped at the read site — `no-threaded-feature-flag` (and
 * the `grid-table-v2` fan-out it was written for) is what a `{ idleRows }`
 * option would rebuild here.
 */
export function buildTraceGroupsWithIdleRows(
  items: readonly SessionTraceItem[]
): TraceGroup[] {
  return collectTraceGroups(items, true);
}

function collectTraceGroups(
  items: readonly SessionTraceItem[],
  idleRows: boolean
): TraceGroup[] {
  const groups: TraceGroup[] = [];
  let current: Extract<TraceGroup, { kind: "msg" }> | null = null;
  let idleOrdinal = 0;

  for (const item of retainedTraceItems(items, idleRows)) {
    if (item.type === "idle") {
      current = flushTraceMessageGroup(groups, current);
      groups.push({ kind: "idle", gapMs: item.gap, ordinal: idleOrdinal });
      idleOrdinal += 1;
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

/**
 * The items the group builder actually walks.
 *
 * A nullish entry and a `sessionstart` marker never produce a group. An `idle`
 * span is dropped HERE rather than inside the loop when its gate is closed
 * (ISS-8652), so a gated-off trace walks the exact item sequence it walked
 * before the gate existed — in particular the message coalescer never sees the
 * span, so it cannot split a run of turns that used to coalesce across it.
 */
function retainedTraceItems(
  items: readonly SessionTraceItem[],
  idleRows: boolean
): RetainedTraceItem[] {
  return items.filter(
    (item): item is RetainedTraceItem =>
      Boolean(item) &&
      item.type !== "sessionstart" &&
      (idleRows || item.type !== "idle")
  );
}

/**
 * What survives {@link retainedTraceItems}. Narrowed rather than left as the
 * whole union so the walk's fall-through still reaches `TraceMessageItem`
 * without re-testing for a `sessionstart` the filter already removed.
 */
type RetainedTraceItem = Exclude<SessionTraceItem, { type: "sessionstart" }>;

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
    group.sessionId === item.actor.sessionId &&
    !("turnStart" in item && item.turnStart)
  );
}

function appendTraceItem(
  group: Extract<TraceGroup, { kind: "msg" }>,
  item: TraceMessageItem
): Extract<TraceGroup, { kind: "msg" }> {
  return {
    ...group,
    cumulativeCost: item.cum,
    costDelta:
      group.costDelta !== undefined || item.costDelta !== undefined
        ? (group.costDelta ?? 0) + (item.costDelta ?? 0)
        : undefined,
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
    costDelta: item.costDelta,
    model: getItemModel(item),
    row: item._row,
    flagReason: item.flag?.reason ?? null,
    segments: [toMessageSegment(item)],
  };
}

function createTraceReasonGroup(
  item: TraceSayItem
): Extract<TraceGroup, { kind: "reason" }> {
  const identity = getTraceItemIdentity(item, item.text);
  return {
    kind: "reason",
    actor: item.actor,
    sessionId: item.actor.sessionId,
    startLabel: formatTraceTimestamp(item.t),
    startMs: item.tMs,
    model: item.model ?? null,
    row: item._row,
    traceId: identity.traceId,
    turnId: identity.turnId,
    text: item.text,
    transcriptIdentity: item.transcriptIdentity,
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
    ...getTraceItemIdentity(item, item.text),
    transcriptIdentity: item.transcriptIdentity,
  };
}

function getTraceItemIdentity(
  item: TraceMessageItem,
  text: string
): { traceId: string; turnId: string } {
  const sessionId = item.actor.sessionId || "unknown-session";
  const base = [
    sessionId,
    item._row,
    item.type,
    item.t,
    item.tMs,
    item.actor.name ?? "",
    item.actor.human ?? "",
    text,
  ].join("\u001f");
  return {
    traceId: `trace:${sessionId}:${item._row}`,
    turnId: `turn:${stableTraceHash(base)}`,
  };
}

function stableTraceHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33 + value.charCodeAt(index)) % 4_294_967_291;
  }
  return hash.toString(36);
}

/**
 * ISS-8767: the same refusal `mergedTraceItemEndMs` applies when it decides
 * where a pause begins, applied where the ROW decides what duration to print.
 *
 * Both derivations read the same `tools.endMs`, and the fold only fixed the
 * idle half: `buildMergedTrace` returns the item unchanged, the branch adapter
 * forwards it, and `TraceMessageRow` prints `group.endMs - group.startMs`. So a
 * nanosecond stamp handed over as milliseconds still rendered as a confident
 * multi-million-year tool duration on a trace whose idle markers had already
 * been repaired — a fabricated measurement, which the repo's bad-data rule puts
 * below no measurement at all.
 *
 * Falling back to the item's own start makes the span zero, and
 * `TraceMessageRow` prints no duration below a second, so a refused extent
 * omits the label rather than replacing it with an invented one.
 */
function getSegmentEndMs(item: TraceMessageItem): number | null {
  if (item.type === "tools") {
    return classifyTraceExtentRejection(item.endMs, item.tMs) === null
      ? item.endMs
      : item.tMs;
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

export function traceGroupContainsRow(
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

export function buildTraceToolRows(
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

type TraceToolRow = {
  key: string;
  tool: Extract<TurnItem, { type: "tools" }>["items"][number];
};

export function getTraceGroupKey(group: TraceGroup): string {
  if (group.kind === "event") {
    return `event-${group.row}`;
  }
  if (group.kind === "end") {
    return `end-${group.item.text}`;
  }
  if (group.kind === "reason") {
    return `reason-${group.row}`;
  }
  if (group.kind === "idle") {
    return `idle-${group.ordinal}`;
  }
  return `msg-${group.row}`;
}

export function getTraceVersion(items: readonly SessionTraceItem[]): string {
  return items
    .map((item) => {
      if ("text" in item) {
        const row = "_row" in item ? item._row : "end";
        return `${row}:${item.text}`;
      }
      return "_row" in item ? `${item._row}:${item.type}` : item.type;
    })
    .join("|");
}

/**
 * The source row a group maps to, or null for the groups that have none — the
 * terminal `end` row and an `idle` span, which describes the pause BETWEEN two
 * rows rather than any row of its own.
 */
function groupRowOf(group: TraceGroup): number | null {
  if (group.kind === "end" || group.kind === "idle") {
    return null;
  }
  return group.row;
}

/**
 * The group index to center for a scrubbed source `row`: the group with the
 * greatest row ≤ `row` (its containing group, since rows coalesce), falling back
 * to the first row-bearing group when the scrub lands before any of them. Mirrors
 * `scrollTraceToRow`'s `[data-row]` selection for the windowed path.
 */
export function groupIndexForRow(
  groups: readonly TraceGroup[],
  row: number
): number | null {
  let bestIndex: number | null = null;
  let bestRow = Number.NEGATIVE_INFINITY;
  let firstIndex: number | null = null;
  groups.forEach((group, index) => {
    const groupRow = groupRowOf(group);
    if (groupRow == null) {
      return;
    }
    if (firstIndex == null) {
      firstIndex = index;
    }
    if (groupRow <= row && groupRow > bestRow) {
      bestRow = groupRow;
      bestIndex = index;
    }
  });
  return bestIndex ?? firstIndex;
}

export function computeGroupCostLabel(
  human: boolean,
  group: Extract<TraceGroup, { kind: "msg" }>
): { cost: string | null; cumulativeTitle: string | undefined } {
  const delta = group.costDelta ?? 0;
  // Any nonzero delta renders — the shared precise formatter (mirroring the
  // collapsed sub-agent box and the branch merged trace) owns the sub-cent
  // display so a real $0.003 turn shows a nonzero figure instead of a floored
  // "$0.00". No local half-cent threshold: the formatter is the single source of
  // truth for how a fine-grained trace cost reads.
  const hasDelta = !human && delta > 0;
  const hasCumFallback =
    !(human || hasDelta) &&
    group.costDelta === undefined &&
    group.cumulativeCost != null &&
    group.cumulativeCost > 0;
  let cost: string | null = null;
  if (hasDelta) {
    cost = formatTraceCostPrecise(delta);
  } else if (hasCumFallback) {
    cost = formatTraceCostPrecise(group.cumulativeCost!);
  }
  const cumulativeTitle =
    hasDelta && group.cumulativeCost != null && group.cumulativeCost > 0
      ? `Cumulative: ${formatTraceCostUsd(group.cumulativeCost)}`
      : undefined;
  return { cost, cumulativeTitle };
}

export type TraceToolItem = Extract<
  TurnItem,
  { type: "tools" }
>["items"][number];
