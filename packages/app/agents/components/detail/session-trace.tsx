"use client";

import type { AgentComponentInvocationAnchor } from "@repo/api/src/types/agent-component-invocation";
import type { TraceCommentKind } from "@repo/api/src/types/comment";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { SESSION_TRACE_IDLE_ROWS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { cn } from "@repo/design-system/lib/utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CircleCheckIcon } from "lucide-react";
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
import { TraceDraftComposer } from "./session-trace-composer";
import type {
  SessionTraceHandle,
  TraceSelectionDraft,
} from "./session-trace-contract";
import {
  buildTraceGroups,
  buildTraceGroupsWithIdleRows,
  getTraceGroupKey,
  getTraceVersion,
  groupIndexForRow,
  type SessionTraceItem,
  type TraceGroup,
  traceGroupContainsRow,
} from "./session-trace-groups";
import type { GutterActorRenderer } from "./session-trace-row-contract";
import { TraceMessageRow, TraceReasonRow } from "./session-trace-rows";
import { resolveTraceSelection } from "./session-trace-selection";
import type { TraceCommentDraft, TraceTextAnchor } from "./trace-comments";
import { TraceEventRow } from "./trace-event-row";
import { TraceIdleRow } from "./trace-idle-row";
export type SessionTraceProps = {
  items: readonly SessionTraceItem[];
  activeRow?: number | null;
  onJump?: (row: number) => void;
  className?: string;
  /** Optional actor identity rendered above timing metadata in each turn gutter. */
  renderGutterActor?: GutterActorRenderer;
  /** Optional selected-passage highlight shared with local trace comments. */
  highlightAnchor?: TraceTextAnchor | null;
  /** Optional local trace comment callback; omitted consumers stay read-only. */
  onSubmitTraceComment?: (draft: TraceCommentDraft) => void;
  /** Reports a resolved native selection without owning its composer UI. */
  onTraceSelectionChange?: (anchor: TraceTextAnchor | null) => void;
  /** Optional invocation deep-link target to reveal and mark exactly once loaded. */
  invocationAnchor?: AgentComponentInvocationAnchor | null;
  /**
   * Opt into windowed (virtualized) rendering — PLN-1148 Phase 4. When true, only
   * the rows near the viewport are mounted, measured against `scrollElementRef`
   * (the scroll viewport the parent owns). Defaults false, which renders every
   * row; Branch detail and Session detail (ISS-12276) both opt in.
   */
  virtualize?: boolean;
  /**
   * The scroll container the virtualizer measures + scrolls (branch trace). May
   * be an ANCESTOR (the single page scroller `.bq-page-scroll`) rather than the
   * trace's immediate parent — the virtualizer offsets rows by a measured
   * `scrollMargin` (the trace's distance from the scroller's content top), so the
   * branch page keeps one scrollbar while still windowing long traces.
   */
  scrollElementRef?: RefObject<HTMLElement | null>;
};

const ESTIMATED_TRACE_ROW_PX = 72;
// Generous first-render estimate until the bounded viewport is measured.
const ASSUMED_TRACE_VIEWPORT_PX = 800;

/**
 * Renders coalesced Session Trace turns: prompt/say/tool/subagent bubbles,
 * system event rows, and terminal rows. Tool and subagent blocks are native
 * buttons so browser keyboard activation works without custom handlers.
 */
const SessionTraceBody = memo(
  forwardRef<SessionTraceHandle, SessionTraceProps>(function SessionTraceBody(
    {
      items,
      activeRow,
      onJump,
      className,
      highlightAnchor,
      onSubmitTraceComment,
      onTraceSelectionChange,
      invocationAnchor,
      renderGutterActor,
      virtualize = false,
      scrollElementRef,
    }: Readonly<SessionTraceProps>,
    ref
  ) {
    // ISS-8652, `…Optional` for the same reason the timeline's gates are: the
    // trace also renders in Storybook and in unit tests, which mount no flag
    // provider, and an absent provider must read as OFF.
    const idleRows = useFeatureFlagEnabledOptional(
      SESSION_TRACE_IDLE_ROWS_FEATURE_FLAG_KEY
    );
    const groups = useMemo(
      () =>
        idleRows
          ? buildTraceGroupsWithIdleRows(items)
          : buildTraceGroups(items),
      [items, idleRows]
    );
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [draft, setDraft] = useState<TraceSelectionDraft | null>(null);
    const selectionEnabled = Boolean(
      onSubmitTraceComment || onTraceSelectionChange
    );
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
      onTraceSelectionChange?.(resolved.anchor);
      if (onSubmitTraceComment) {
        setDraft(resolved);
      }
    }, [onSubmitTraceComment, onTraceSelectionChange, selectionEnabled]);

    const submitDraft = useCallback(
      (payload: {
        body: string;
        mentions?: string[];
        kind?: TraceCommentKind;
      }) => {
        if (!draft) {
          return;
        }
        onSubmitTraceComment?.({
          anchor: draft.anchor,
          body: payload.body,
          ...(payload.mentions && payload.mentions.length > 0
            ? { mentions: payload.mentions }
            : {}),
          ...(payload.kind ? { kind: payload.kind } : {}),
        });
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
    // ISS-12276: the scroller is usually an ANCESTOR, and React attaches an
    // ancestor's ref only after this subtree's layout effects run. When the
    // trace mounts in the same commit as its scroller (the desktop projection
    // renders immediately), reading the ref during layout sees `null`, so the
    // virtualizer never attached its scroll listener and the margin was never
    // measured. A passive effect runs after every ref of the commit is set.
    const [scrollElement, setScrollElement] = useState<HTMLElement | null>(
      null
    );
    useEffect(() => {
      setScrollElement(windowed ? (scrollElementRef?.current ?? null) : null);
    });
    useLayoutEffect(() => {
      if (!windowed) {
        return;
      }
      const scroller = scrollElement;
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
    }, [windowed, scrollElement]);

    const virtualizer = useVirtualizer({
      count: groups.length,
      enabled: windowed,
      estimateSize: () => ESTIMATED_TRACE_ROW_PX,
      getScrollElement: () => scrollElement,
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
        revealRow(row: number): boolean {
          if (!windowed) {
            return true;
          }
          const index = groupIndexForRow(groups, row);
          const scroller = scrollElementRef?.current;
          if (
            index == null ||
            !scroller ||
            rootRef.current?.querySelector(`[data-index="${index}"]`)
          ) {
            return true;
          }
          // The virtualizer's own scroll, so its offset bookkeeping and the
          // row measurements it reconciles against stay coherent; a direct
          // `scrollTop` write left its tracked offset stale, and the size
          // compensation for rows measured on the way in then scrolled back
          // from that stale offset. The caller corrects for the sticky header
          // once the row is mounted. Still unmounted here, so the caller must
          // not land on whichever anchor happens to be nearest.
          virtualizer.scrollToIndex(index, { align: "start" });
          return false;
        },
      }),
      [windowed, groups, virtualizer, scrollElementRef]
    );

    if (windowed) {
      // Selection listeners live on the trace root so text selection can stay
      // native while still resolving anchors after mouse or keyboard selection.
      return (
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
                  selectionEnabled,
                  invocationAnchor,
                  renderGutterActor
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

    // Selection listeners live on the trace root so text selection can stay
    // native while still resolving anchors after mouse or keyboard selection.
    return (
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
              selectionEnabled,
              invocationAnchor,
              renderGutterActor
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

/**
 * The session trace. A thin forwarding wrapper around {@link SessionTraceBody}:
 * it used to also mount the ISS-4767 slash-command fold provider, which ISS-5366
 * retired when the fold graduated to always-on and the per-trace flag read went
 * away with it.
 */
export const SessionTrace = forwardRef<SessionTraceHandle, SessionTraceProps>(
  function SessionTrace(props, ref) {
    return <SessionTraceBody {...props} ref={ref} />;
  }
);

/**
 * One coalesced trace group → its row element (key supplied by the caller).
 *
 * `activeRow` changes on every scroll frame (it drives the read-only "you are
 * here" highlight), so this resolves each group's active-ness to a plain
 * boolean HERE and hands the memoized row that boolean rather than the raw
 * `activeRow`. Only the ≤2 rows whose `active` actually flips get a changed
 * prop; the other N-1 rows bail out of re-render via `memo`. Passing the raw
 * `activeRow` down instead re-rendered (and re-rendered the markdown body of)
 * every row on every scroll tick — an O(N) main-thread pass per frame that hung
 * the non-virtualized Session detail page on large sessions.
 */
function renderTraceGroup(
  group: TraceGroup,
  activeRow: number | null | undefined,
  onJump: ((row: number) => void) | undefined,
  highlightAnchor: TraceTextAnchor | null | undefined,
  selectionEnabled: boolean,
  invocationAnchor: AgentComponentInvocationAnchor | null | undefined,
  renderGutterActor: GutterActorRenderer | undefined
): ReactNode {
  if (group.kind === "event") {
    return (
      <TraceEventRow
        active={group.row === activeRow}
        group={group}
        invocationAnchor={invocationAnchor}
        onJump={onJump}
      />
    );
  }
  if (group.kind === "idle") {
    return <TraceIdleRow group={group} />;
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
        invocationAnchor={invocationAnchor}
        onJump={onJump}
        renderGutterActor={renderGutterActor}
        selectionEnabled={selectionEnabled}
      />
    );
  }
  return (
    <TraceMessageRow
      active={traceGroupContainsRow(group, activeRow)}
      group={group}
      highlightAnchor={highlightAnchor}
      invocationAnchor={invocationAnchor}
      onJump={onJump}
      renderGutterActor={renderGutterActor}
      selectionEnabled={selectionEnabled}
    />
  );
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
