"use client";

import type { TurnActor, TurnItem } from "@repo/api/src/types/agent-session";
import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";
import { Button } from "@repo/design-system/components/ui/button";
import { CommentComposer } from "@repo/design-system/components/ui/comment-composer";
import { cn } from "@repo/design-system/lib/utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AtSignIcon,
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  MessageCircleIcon,
  PaperclipIcon,
  SmileIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ReactNode, RefObject } from "react";
import {
  Fragment,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TraceCommentDraft, TraceTextAnchor } from "./trace-comments";
import { TraceMessageBody } from "./trace-message-body";

export type SessionTraceProps = {
  items: readonly SessionTraceItem[];
  activeRow?: number | null;
  onJump?: (row: number) => void;
  className?: string;
  /** Optional selected-passage highlight shared with local trace comments. */
  highlightAnchor?: TraceTextAnchor | null;
  /** Optional local trace comment callback; omitted consumers stay read-only. */
  onSubmitTraceComment?: (draft: TraceCommentDraft) => void;
  /**
   * Opt into windowed (virtualized) rendering — PLN-1148 Phase 4. When true, only
   * the rows near the viewport are mounted, measured against `scrollElementRef`
   * (the bounded scroll viewport the parent owns). Defaults false: the agents
   * Session detail page, whose whole document scrolls together, renders every row
   * exactly as before. Until the viewport is measured (SSR / jsdom / first paint)
   * this degrades to rendering all rows, so server output and unit tests that
   * assert on off-screen rows are unaffected.
   */
  virtualize?: boolean;
  /**
   * The scroll container the virtualizer measures + scrolls (branch trace). May
   * be an ANCESTOR (the single page scroller `.bq-page-scroll`) rather than the
   * trace's immediate parent — the virtualizer offsets rows by a measured
   * `scrollMargin` (the trace's distance from the scroller's content top), so the
   * branch page keeps one scrollbar while still windowing long traces.
   */
  scrollElementRef?: RefObject<HTMLDivElement | null>;
};

/**
 * Imperative handle so a parent (the branch merged trace) can scroll the trace to
 * a source row in response to a timeline/playhead scrub — `scrollToIndex` when
 * windowed, the bounded-viewport `[data-row]` scroll when every row is mounted.
 */
export type SessionTraceHandle = {
  scrollToRow(row: number): void;
};

const ESTIMATED_TRACE_ROW_PX = 72;
// Assumed bounded-viewport height for the first render's window, before the real
// `.bq-trace-scroll` height (max 70vh) is measured. Slightly generous so the
// initial paint fills a typical viewport; the virtualizer corrects it on mount.
const ASSUMED_TRACE_VIEWPORT_PX = 800;

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
    }
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

type TraceSelectionDraft = {
  anchor: TraceTextAnchor;
  position: { x: number; y: number };
  mode: "affordance" | "composer";
};

type TraceTextHighlight =
  | { kind: "exact"; startOffset: number; endOffset: number }
  | { kind: "row" };

const TRACE_LINK_PATTERN = /(#\d+)/g;
const MARKDOWN_IMAGE_PATTERN = /^!\[([^\]]*)\]\([^)]+\)/;
const MARKDOWN_LINK_PATTERN = /^\[([^\]]+)\]\([^)]+\)/;
const MARKDOWN_EMPHASIS_PATTERN = /^(\*\*|__|\*|_|~~|`)(.*?)\1/;

/**
 * Renders coalesced Session Trace turns: prompt/say/tool/subagent bubbles,
 * system event rows, and terminal rows. Tool and subagent blocks are native
 * buttons so browser keyboard activation works without custom handlers.
 */
export const SessionTrace = memo(
  forwardRef<SessionTraceHandle, SessionTraceProps>(function SessionTrace(
    {
      items,
      activeRow,
      onJump,
      className,
      highlightAnchor,
      onSubmitTraceComment,
      virtualize = false,
      scrollElementRef,
    }: Readonly<SessionTraceProps>,
    ref
  ) {
    const groups = useMemo(() => buildTraceGroups(items), [items]);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [draft, setDraft] = useState<TraceSelectionDraft | null>(null);
    const selectionEnabled = Boolean(onSubmitTraceComment);
    const activeHighlight = draft?.anchor ?? highlightAnchor ?? null;
    const traceVersion = useMemo(() => getTraceVersion(items), [items]);

    const clearDraft = useCallback(() => setDraft(null), []);
    const prepareSelection = useCallback(() => {
      if (!selectionEnabled) {
        return;
      }
      const selection = globalThis.getSelection?.();
      const resolved = resolveTraceSelection(selection, rootRef.current);
      if (!resolved) {
        return;
      }
      setDraft(resolved);
    }, [selectionEnabled]);

    const submitDraft = useCallback(
      (body: string) => {
        if (!draft) {
          return;
        }
        onSubmitTraceComment?.({ anchor: draft.anchor, body });
        setDraft(null);
        globalThis.getSelection?.()?.removeAllRanges();
      },
      [draft, onSubmitTraceComment]
    );

    useEffect(() => {
      if (!selectionEnabled) {
        setDraft(null);
      }
    }, [selectionEnabled]);

    // Clear any unopened draft if the producer swaps trace rows under us.
    // biome-ignore lint/correctness/useExhaustiveDependencies: traceVersion is the derived row/text signature this cleanup intentionally tracks.
    useEffect(() => {
      setDraft(null);
    }, [traceVersion]);

    useEffect(() => {
      if (!draft) {
        return;
      }

      function onPointerDown(event: globalThis.PointerEvent) {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest("[data-comment-control]")
        ) {
          return;
        }
        setDraft(null);
      }

      function onKeyDown(event: globalThis.KeyboardEvent) {
        if (event.key === "Escape") {
          setDraft(null);
        }
      }

      globalThis.document.addEventListener("pointerdown", onPointerDown);
      globalThis.document.addEventListener("keydown", onKeyDown);
      return () => {
        globalThis.document.removeEventListener("pointerdown", onPointerDown);
        globalThis.document.removeEventListener("keydown", onKeyDown);
      };
    }, [draft]);

    // Windowing from the FIRST render (seeded by `initialRect` before the
    // bounded viewport is measured, then refined by the virtualizer's
    // ResizeObserver) means a long trace never builds its full DOM — the
    // dominant load cost, paid on every tab open because the tab unmounts on
    // switch (PLN-1148 follow-up).
    const windowed = virtualize;

    // The windowed list can live below other content (the sticky timeline) inside
    // an ANCESTOR page scroller, so the virtualizer needs the list's offset from
    // the scroller's content top as `scrollMargin`. Measured from the DOM (and on
    // viewport resize, which can reflow the content above); 0 when the scroller is
    // the immediate parent.
    const [scrollMargin, setScrollMargin] = useState(0);
    useLayoutEffect(() => {
      if (!windowed) {
        return;
      }
      const scroller = scrollElementRef?.current;
      const measure = () => {
        const list = rootRef.current;
        if (!(list && scroller)) {
          return;
        }
        const offset =
          list.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop;
        setScrollMargin((prev) =>
          Math.abs(prev - offset) > 1 ? offset : prev
        );
      };
      measure();
      if (!scroller) {
        return;
      }
      const observer = new ResizeObserver(measure);
      observer.observe(scroller);
      return () => observer.disconnect();
    }, [windowed, scrollElementRef]);

    const virtualizer = useVirtualizer({
      count: groups.length,
      enabled: windowed,
      estimateSize: () => ESTIMATED_TRACE_ROW_PX,
      getScrollElement: () => scrollElementRef?.current ?? null,
      initialRect: { height: ASSUMED_TRACE_VIEWPORT_PX, width: 0 },
      overscan: 12,
      scrollMargin,
    });

    useImperativeHandle(
      ref,
      () => ({
        scrollToRow(row: number) {
          if (windowed) {
            const index = groupIndexForRow(groups, row);
            if (index != null) {
              virtualizer.scrollToIndex(index, {
                align: "center",
                behavior: "smooth",
              });
            }
            return;
          }
          // Fallback (all rows mounted): scroll the bounded viewport to the
          // rendered row in place, exactly as the pre-virtualization path did.
          scrollTraceToRow(scrollElementRef?.current ?? null, row);
        },
      }),
      [windowed, groups, virtualizer, scrollElementRef]
    );

    if (windowed) {
      return (
        // Selection listeners live on the trace root so text selection can stay
        // native while still resolving anchors after mouse or keyboard selection.
        // biome-ignore lint/a11y/noStaticElementInteractions: the element remains a non-focusable document region; keyboard interaction is delegated to selected text.
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the handler observes native selection, not an element-specific action.
        <div
          className={cn("st", className)}
          onKeyUp={prepareSelection}
          onMouseUp={prepareSelection}
          ref={rootRef}
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const group = groups[virtualRow.index];
            if (!group) {
              return null;
            }
            return (
              <div
                data-index={virtualRow.index}
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                style={{
                  left: 0,
                  position: "absolute",
                  top: 0,
                  // Offset by scrollMargin so rows position relative to the
                  // list's own top, not the (ancestor) scroller's content top.
                  transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                  width: "100%",
                }}
              >
                {renderTraceGroup(
                  group,
                  activeRow,
                  onJump,
                  activeHighlight,
                  selectionEnabled
                )}
              </div>
            );
          })}
          {draft ? (
            <TraceDraftComposer
              draft={draft}
              onCancel={clearDraft}
              onSubmit={submitDraft}
            />
          ) : null}
        </div>
      );
    }

    return (
      // Selection listeners live on the trace root so text selection can stay
      // native while still resolving anchors after mouse or keyboard selection.
      // biome-ignore lint/a11y/noStaticElementInteractions: the element remains a non-focusable document region; keyboard interaction is delegated to selected text.
      // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the handler observes native selection, not an element-specific action.
      <div
        className={cn("st", className)}
        onKeyUp={prepareSelection}
        onMouseUp={prepareSelection}
        ref={rootRef}
      >
        {groups.map((group) => (
          <Fragment key={getTraceGroupKey(group)}>
            {renderTraceGroup(
              group,
              activeRow,
              onJump,
              activeHighlight,
              selectionEnabled
            )}
          </Fragment>
        ))}
        {draft ? (
          <TraceDraftComposer
            draft={draft}
            onCancel={clearDraft}
            onSubmit={submitDraft}
          />
        ) : null}
      </div>
    );
  })
);

/** One coalesced trace group → its row element (key supplied by the caller). */
function renderTraceGroup(
  group: TraceGroup,
  activeRow: number | null | undefined,
  onJump: ((row: number) => void) | undefined,
  highlightAnchor: TraceTextAnchor | null | undefined,
  selectionEnabled: boolean
): ReactNode {
  if (group.kind === "event") {
    return (
      <TraceEventRow
        active={group.row === activeRow}
        group={group}
        onJump={onJump}
      />
    );
  }
  if (group.kind === "end") {
    return (
      <div className="st-end">
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
        highlightAnchor={highlightAnchor}
        onJump={onJump}
        selectionEnabled={selectionEnabled}
      />
    );
  }
  return (
    <TraceMessageRow
      activeRow={activeRow}
      group={group}
      highlightAnchor={highlightAnchor}
      onJump={onJump}
      selectionEnabled={selectionEnabled}
    />
  );
}

/** The source row a group maps to, or null for the terminal `end` row. */
function groupRowOf(group: TraceGroup): number | null {
  return group.kind === "end" ? null : group.row;
}

/**
 * The group index to center for a scrubbed source `row`: the group with the
 * greatest row ≤ `row` (its containing group, since rows coalesce), falling back
 * to the first row-bearing group when the scrub lands before any of them. Mirrors
 * `scrollTraceToRow`'s `[data-row]` selection for the windowed path.
 */
function groupIndexForRow(
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

/**
 * Scroll the bounded `container` so the row nearest to `row` is centered. Targets
 * the rendered element with the greatest `data-row` that is ≤ `row` (its
 * containing group/segment), falling back to the first row when the scrub lands
 * before any rendered row.
 *
 * Scrolls ONLY the bounded `container` (its own `scrollTop`) — never
 * `scrollIntoView`, which walks up and scrolls the nearest scrollable ancestor.
 * On the branch detail page that ancestor is the whole-page scroll container, so
 * a scrub would yank the entire page. Used when every row is mounted (the
 * non-windowed fallback); the windowed path uses `virtualizer.scrollToIndex`.
 */
function scrollTraceToRow(container: HTMLElement | null, row: number): void {
  if (!container) {
    return;
  }
  let target: HTMLElement | null = null;
  let targetRow = Number.NEGATIVE_INFINITY;
  let firstNode: HTMLElement | null = null;
  let firstRow = Number.POSITIVE_INFINITY;
  for (const node of container.querySelectorAll<HTMLElement>("[data-row]")) {
    const value = Number(node.getAttribute("data-row"));
    if (Number.isNaN(value)) {
      continue;
    }
    if (value < firstRow) {
      firstRow = value;
      firstNode = node;
    }
    if (value <= row && value > targetRow) {
      targetRow = value;
      target = node;
    }
  }
  const node = target ?? firstNode;
  if (!node) {
    return;
  }
  const containerRect = container.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  // Offset that centers the node within the viewport (the `block: "center"`
  // equivalent), clamped by the browser to the container's scroll range.
  const center = (container.clientHeight - nodeRect.height) / 2;
  const nextTop =
    container.scrollTop + (nodeRect.top - containerRect.top - center);
  if (typeof container.scrollTo === "function") {
    container.scrollTo({ top: nextTop, behavior: "smooth" });
    return;
  }
  container.scrollTop = nextTop;
}

function computeGroupCostLabel(
  human: boolean,
  group: Extract<TraceGroup, { kind: "msg" }>
): { cost: string | null; cumulativeTitle: string | undefined } {
  const delta = group.costDelta ?? 0;
  const hasDelta = !human && delta >= 0.005;
  const hasCumFallback =
    !(human || hasDelta) &&
    group.costDelta === undefined &&
    group.cumulativeCost != null &&
    group.cumulativeCost > 0;
  let cost: string | null = null;
  if (hasDelta) {
    cost = formatTraceCost(delta);
  } else if (hasCumFallback) {
    cost = formatTraceCost(group.cumulativeCost!);
  }
  const cumulativeTitle =
    hasDelta && group.cumulativeCost != null && group.cumulativeCost > 0
      ? `Cumulative: ${formatTraceCost(group.cumulativeCost)}`
      : undefined;
  return { cost, cumulativeTitle };
}

function TraceMessageRow({
  activeRow,
  group,
  highlightAnchor,
  onJump,
  selectionEnabled,
}: Readonly<{
  activeRow?: number | null;
  group: Extract<TraceGroup, { kind: "msg" }>;
  highlightAnchor?: TraceTextAnchor | null;
  onJump?: (row: number) => void;
  selectionEnabled: boolean;
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
  const { cost, cumulativeTitle } = computeGroupCostLabel(human, group);

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
              traceActor={group.actor}
              traceHighlight={getTraceTextHighlight(
                highlightAnchor,
                segment.row,
                segment.text,
                segment.traceId,
                segment.turnId
              )}
              traceId={segment.traceId}
              traceRow={segment.row}
              traceSelectionEnabled={selectionEnabled}
              traceSessionId={group.sessionId}
              traceText={segment.text}
              traceTurnId={segment.turnId}
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
          {cost ? (
            <span className="st-gut-line cost" title={cumulativeTitle}>
              {cost}
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function TraceReasonRow({
  active,
  group,
  highlightAnchor,
  onJump,
  selectionEnabled,
}: Readonly<{
  active?: boolean;
  group: Extract<TraceGroup, { kind: "reason" }>;
  highlightAnchor?: TraceTextAnchor | null;
  onJump?: (row: number) => void;
  selectionEnabled: boolean;
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
        {open ? (
          <TraceMessageBody
            onJump={onJump}
            text={group.text}
            traceActor={group.actor}
            traceHighlight={getTraceTextHighlight(
              highlightAnchor,
              group.row,
              group.text,
              group.traceId,
              group.turnId
            )}
            traceId={group.traceId}
            traceRow={group.row}
            traceSelectionEnabled={selectionEnabled}
            traceSessionId={group.sessionId}
            traceText={group.text}
            traceTurnId={group.turnId}
          />
        ) : null}
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

const TRACE_COMMENT_POPOVER_GUTTER = 8;
const TRACE_COMMENT_COMPOSER_MAX_WIDTH = 340;

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

function TraceDraftComposer({
  draft,
  onCancel,
  onSubmit,
}: Readonly<{
  draft: TraceSelectionDraft;
  onCancel: () => void;
  onSubmit: (body: string) => void;
}>) {
  const [mode, setMode] = useState(draft.mode);
  const style = {
    left: `${draft.position.x}px`,
    top: `${draft.position.y}px`,
  };

  if (mode === "affordance") {
    return (
      <button
        className="st-comment-pop"
        data-comment-control="true"
        onClick={() => setMode("composer")}
        style={style}
        type="button"
      >
        <MessageCircleIcon aria-hidden className="size-3.5" />
        Comment
      </button>
    );
  }

  return (
    <div
      className="st-comment-pop st-comment-compose"
      data-comment-control="true"
      style={style}
    >
      <div className="st-comment-quote">{draft.anchor.selectedText}</div>
      <CommentComposer
        containerClassName="flex flex-col gap-2"
        leadingActions={<TraceComposerLeadingActions />}
        minHeightClassName="min-h-[72px]"
        onCancel={onCancel}
        onSubmit={onSubmit}
        placeholder="Comment on this passage..."
        submitLabel="Comment"
      />
    </div>
  );
}

function resolveTraceSelection(
  selection: Selection | null | undefined,
  root: HTMLElement | null
): TraceSelectionDraft | null {
  if (
    !(selection && root && selection.rangeCount > 0 && !selection.isCollapsed)
  ) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) {
    return null;
  }
  const anchorElement = getSelectionElement(range.startContainer);
  const focusElement = getSelectionElement(range.endContainer);
  const startSource = anchorElement?.closest<HTMLElement>(
    "[data-trace-text-row][data-trace-text]"
  );
  const endSource = focusElement?.closest<HTMLElement>(
    "[data-trace-text-row][data-trace-text]"
  );
  if (!(startSource && endSource && startSource === endSource)) {
    return null;
  }
  const row = Number(startSource.dataset.traceTextRow);
  const sourceText =
    startSource.textContent ?? startSource.dataset.traceText ?? "";
  const traceId = startSource.dataset.traceId;
  const turnId = startSource.dataset.traceTurnId;
  const offsets = getRangeTextOffsets(startSource, range);
  const selectedText = selection.toString();
  const trimmedSelection = selectedText.trim();
  if (
    !(
      Number.isFinite(row) &&
      sourceText &&
      trimmedSelection &&
      offsets &&
      traceId &&
      turnId
    )
  ) {
    return null;
  }
  const leadingTrim = selectedText.length - selectedText.trimStart().length;
  const startOffset = offsets.startOffset + leadingTrim;
  const endOffset = startOffset + trimmedSelection.length;
  if (
    startOffset < 0 ||
    endOffset > sourceText.length ||
    sourceText.slice(startOffset, endOffset) !== trimmedSelection
  ) {
    return null;
  }
  const rect = getTraceRangeRect(range);
  const rootRect = root.getBoundingClientRect();
  return {
    anchor: {
      actor: {
        human: startSource.dataset.traceHuman || null,
        name: startSource.dataset.traceActor || "Agent",
      },
      endOffset,
      row,
      selectedText: trimmedSelection,
      sessionId: startSource.dataset.traceSessionId || null,
      sourceText,
      startOffset,
      traceId,
      turnId,
    },
    mode: "affordance",
    position: {
      x: getTraceCommentPopoverX(rect, rootRect),
      y: Math.max(
        TRACE_COMMENT_POPOVER_GUTTER,
        rect.bottom - rootRect.top + TRACE_COMMENT_POPOVER_GUTTER
      ),
    },
  };
}

function getTraceCommentPopoverX(rect: DOMRect, rootRect: DOMRect): number {
  const rootWidth = Math.max(0, rootRect.width);
  const composerWidth = Math.min(
    TRACE_COMMENT_COMPOSER_MAX_WIDTH,
    Math.max(0, rootWidth - TRACE_COMMENT_POPOVER_GUTTER * 2)
  );
  const maxX = rootWidth
    ? Math.max(
        TRACE_COMMENT_POPOVER_GUTTER,
        rootWidth - composerWidth - TRACE_COMMENT_POPOVER_GUTTER
      )
    : TRACE_COMMENT_POPOVER_GUTTER;
  const selectionX = rect.left - rootRect.left;

  if (!Number.isFinite(selectionX)) {
    return TRACE_COMMENT_POPOVER_GUTTER;
  }

  return Math.min(Math.max(TRACE_COMMENT_POPOVER_GUTTER, selectionX), maxX);
}

function getSelectionElement(node: Node): Element | null {
  if (node instanceof Element) {
    return node;
  }
  return node.parentNode instanceof Element ? node.parentNode : null;
}

function getRangeTextOffsets(
  source: HTMLElement,
  range: Range
): { startOffset: number; endOffset: number } | null {
  try {
    const beforeStart = source.ownerDocument.createRange();
    beforeStart.selectNodeContents(source);
    beforeStart.setEnd(range.startContainer, range.startOffset);
    const beforeEnd = source.ownerDocument.createRange();
    beforeEnd.selectNodeContents(source);
    beforeEnd.setEnd(range.endContainer, range.endOffset);
    return {
      startOffset: beforeStart.toString().length,
      endOffset: beforeEnd.toString().length,
    };
  } catch {
    return null;
  }
}

function getTraceRangeRect(range: Range): DOMRect {
  if ("getBoundingClientRect" in range) {
    return range.getBoundingClientRect();
  }
  return {
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    toJSON: () => ({}),
    top: 0,
    width: 0,
    x: 0,
    y: 0,
  };
}

function getTraceTextHighlight(
  anchor: TraceTextAnchor | null | undefined,
  row: number,
  sourceText: string,
  traceId: string,
  turnId: string
): TraceTextHighlight | null {
  if (
    !anchor ||
    anchor.row !== row ||
    anchor.traceId !== traceId ||
    anchor.turnId !== turnId
  ) {
    return null;
  }
  if (
    anchor.sourceText === sourceText &&
    anchor.startOffset >= 0 &&
    anchor.endOffset > anchor.startOffset &&
    anchor.endOffset <= sourceText.length &&
    sourceText.slice(anchor.startOffset, anchor.endOffset) ===
      anchor.selectedText
  ) {
    return {
      kind: "exact",
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
    };
  }
  const renderedText = getMarkdownRenderedText(sourceText);
  if (
    anchor.sourceText === renderedText &&
    anchor.startOffset >= 0 &&
    anchor.endOffset > anchor.startOffset &&
    anchor.endOffset <= renderedText.length &&
    renderedText.slice(anchor.startOffset, anchor.endOffset) ===
      anchor.selectedText
  ) {
    return {
      kind: "exact",
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
    };
  }
  return { kind: "row" };
}

/**
 * Computes the same rendered-text coordinate space used by browser selections
 * for inline markdown constructs that hide delimiters while preserving visible
 * labels/content.
 */
function getMarkdownRenderedText(sourceText: string): string {
  let out = "";
  for (let index = 0; index < sourceText.length; index += 1) {
    const textFromIndex = sourceText.slice(index);
    const imageMatch = textFromIndex.match(MARKDOWN_IMAGE_PATTERN);
    const linkMatch = textFromIndex.match(MARKDOWN_LINK_PATTERN);
    const emphasisMatch = textFromIndex.match(MARKDOWN_EMPHASIS_PATTERN);
    const match = imageMatch ?? linkMatch ?? emphasisMatch;

    if (match) {
      const visibleText = match[2] ?? match[1] ?? "";
      out += visibleText;
      index += match[0].length - 1;
      continue;
    }

    out += sourceText[index];
  }
  return out;
}

function TraceComposerLeadingActions() {
  return (
    <>
      <Button
        aria-disabled
        aria-label="Attach file"
        className="h-7 w-7"
        data-comment-control="true"
        size="icon"
        tabIndex={-1}
        type="button"
        variant="ghost"
      >
        <PaperclipIcon aria-hidden className="h-3.5 w-3.5" />
      </Button>
      <Button
        aria-disabled
        aria-label="Mention"
        className="h-7 w-7"
        data-comment-control="true"
        size="icon"
        tabIndex={-1}
        type="button"
        variant="ghost"
      >
        <AtSignIcon aria-hidden className="h-3.5 w-3.5" />
      </Button>
      <Button
        aria-disabled
        aria-label="Add emoji"
        className="h-7 w-7"
        data-comment-control="true"
        size="icon"
        tabIndex={-1}
        type="button"
        variant="ghost"
      >
        <SmileIcon aria-hidden className="h-3.5 w-3.5" />
      </Button>
    </>
  );
}

function getTraceVersion(items: readonly SessionTraceItem[]): string {
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
