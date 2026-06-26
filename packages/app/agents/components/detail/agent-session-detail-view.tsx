"use client";

import {
  type ActivityBucket,
  type AgentSessionDetail,
  AgentSessionState,
  type SessionPR,
  type SessionSpan,
  type SessionThrottle,
  type TurnItem,
} from "@repo/api/src/types/agent-session";
import { formatTime } from "@repo/app/shared/lib/date-utils";
import { getDurationScaleMinutes } from "@repo/app/shared/lib/format-utils";
import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Card, CardContent } from "@repo/design-system/components/ui/card";
import { CommentComposer } from "@repo/design-system/components/ui/comment-composer";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import {
  ActivityIcon,
  AlertCircleIcon,
  ArrowLeftIcon,
  ArrowUpDownIcon,
  AtSignIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleDollarSignIcon,
  ClockIcon,
  CornerUpLeftIcon,
  CrosshairIcon,
  FolderGit2Icon,
  GaugeIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  GripVerticalIcon,
  HashIcon,
  type LucideIcon,
  MessageCircleIcon,
  PaperclipIcon,
  SmileIcon,
  SquareCheckIcon,
  TerminalIcon,
} from "lucide-react";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { getAutonomyLabel } from "../../lib/autonomy";
import {
  type AgentSessionDetailContent,
  buildSessionDetailContent,
  safeFormatDateTime,
} from "./detail-content";
import { SessionTrace } from "./session-trace";

/** Shared web and desktop session detail body for transcript-first review. */
export type AgentSessionDetailViewProps = {
  session?: AgentSessionDetail;
  isLoading: boolean;
  backHref: string;
  /** Caller-controlled comments rail visibility for surfaces without durable comments. */
  commentsRailOpen?: boolean;
};

/**
 * Replaces the legacy card dashboard with the shared Session Trace workspace.
 * Route shells own breadcrumbs and feature availability; this component owns
 * the portable trace, properties, timeline, and comments surfaces.
 */
export function AgentSessionDetailView({
  session,
  isLoading,
  backHref,
  commentsRailOpen = true,
}: AgentSessionDetailViewProps) {
  const content = useMemo(
    () => (session ? buildSessionDetailContent(session) : null),
    [session]
  );
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [commentsWidth, setCommentsWidth] = useState(
    DEFAULT_COMMENTS_RAIL_WIDTH
  );

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        <Skeleton className="h-[520px] w-full" />
      </div>
    );
  }

  if (!(session && content)) {
    return (
      <div className="flex min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        <Card className="w-full">
          <CardContent className="pt-6">
            <EmptyState
              className="py-16"
              description="The session may not exist, or you may not have access to it."
              icon={AlertCircleIcon}
              title="Session not found"
            />
            <div className="mt-4 flex justify-center">
              <Link className="sd3-back" href={backHref}>
                <ArrowLeftIcon aria-hidden className="size-3.5" />
                Back to Sessions
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <SessionDetailWorkspace
      activeRow={activeRow}
      commentsRailOpen={commentsRailOpen}
      commentsWidth={commentsWidth}
      content={content}
      onActiveRowChange={setActiveRow}
      onCommentsWidthChange={setCommentsWidth}
      session={session}
    />
  );
}

function SessionDetailWorkspace({
  activeRow,
  commentsWidth,
  commentsRailOpen,
  content,
  onActiveRowChange,
  onCommentsWidthChange,
  session,
}: Readonly<{
  activeRow: number | null;
  commentsWidth: number;
  commentsRailOpen: boolean;
  content: AgentSessionDetailContent;
  onActiveRowChange: (row: number | null) => void;
  onCommentsWidthChange: (width: number) => void;
  session: AgentSessionDetail;
}>) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const markers = useMemo(() => buildActivityMarkers(session), [session]);
  const markersByRow = useMemo(() => {
    const byRow = new Map<number, ActivityMarker>();
    for (const marker of markers) {
      if (!byRow.has(marker.tl)) {
        byRow.set(marker.tl, marker);
      }
    }
    return byRow;
  }, [markers]);
  const buckets = useMemo(
    () => buildActivityBuckets(session, markers),
    [markers, session]
  );
  const activeMarker = getActiveMarker(markers, activeRow);
  const span = getSessionSpan(session, markers);
  const scaleMinutes = getDurationScaleMinutes(
    session.startedAt,
    session.endedAt ?? session.updatedAt
  );
  const traceCountLabel = getTraceCountLabel(session);
  const [traceComments, setTraceComments] = useState<TraceComment[]>([]);

  const scrollToTraceRow = useCallback((row: number, flash: boolean) => {
    const scroller = scrollRef.current;
    if (!scroller) {
      return;
    }
    const nodes = Array.from(
      scroller.querySelectorAll<HTMLElement>(".st [data-row]")
    );
    let target: HTMLElement | null = null;
    let bestRow = Number.NEGATIVE_INFINITY;
    for (const node of nodes) {
      const dataRow = Number(node.dataset.row);
      if (Number.isFinite(dataRow) && dataRow <= row && dataRow > bestRow) {
        bestRow = dataRow;
        target = node;
      }
    }
    target ??= nodes[0] ?? null;
    if (!target) {
      return;
    }
    const sticky = scroller.querySelector<HTMLElement>(
      ".sd3-stickyhead.is-sticky"
    );
    const offset = (sticky?.offsetHeight ?? 0) + 14;
    const scrollRect = scroller.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    scroller.scrollTop += targetRect.top - scrollRect.top - offset;
    if (flash) {
      target.classList.remove("st-flash");
      target.getBoundingClientRect();
      target.classList.add("st-flash");
    }
  }, []);

  const jumpToRow = useCallback(
    (row: number, flash = true) => {
      onActiveRowChange(row);
      scrollToTraceRow(row, flash);
    },
    [onActiveRowChange, scrollToTraceRow]
  );

  const submitTraceComment = useCallback(
    (body: string) => {
      setTraceComments((current) => [
        ...current,
        {
          id: `trace-comment-${current.length + 1}`,
          body,
          markerLabel: activeMarker?.label ?? "Session",
          row: activeMarker?.tl ?? null,
        },
      ]);
    },
    [activeMarker]
  );

  const scrubToPercent = useCallback(
    (percent: number) => {
      const bucket =
        buckets[getBucketIndexFromPercent(percent, buckets.length)];
      const row = bucket?.tl0 ?? markers[0]?.tl ?? 0;
      jumpToRow(row, false);
    },
    [buckets, jumpToRow, markers]
  );

  const handleTraceScroll = useCallback(() => {
    if (rafRef.current !== null) {
      return;
    }
    rafRef.current = globalThis.requestAnimationFrame(() => {
      rafRef.current = null;
      const scroller = scrollRef.current;
      if (!scroller) {
        return;
      }
      const sticky = scroller.querySelector<HTMLElement>(
        ".sd3-stickyhead.is-sticky"
      );
      const top =
        scroller.getBoundingClientRect().top + (sticky?.offsetHeight ?? 0) + 6;
      let row = 0;
      for (const node of scroller.querySelectorAll<HTMLElement>(
        ".st [data-row]"
      )) {
        const nextRow = Number(node.dataset.row);
        if (
          Number.isFinite(nextRow) &&
          node.getBoundingClientRect().top <= top
        ) {
          row = nextRow;
        }
      }
      onActiveRowChange(row);
    });
  }, [onActiveRowChange]);

  return (
    <div
      className="sd3"
      style={{ "--sd3-cmts-w": `${commentsWidth}px` } as CSSProperties}
    >
      <div className="sd3-main">
        <div
          className="sd3-scroll"
          onScroll={handleTraceScroll}
          ref={scrollRef}
        >
          <article className="sd3-doc">
            <div className="sd3-stickyhead is-sticky">
              <header className="sd3-head">
                <div className="space-y-2">
                  <h1 className="sd3-title">
                    {session.name ?? session.externalSessionId}
                  </h1>
                </div>

                <SessionPropertiesPanel content={content} session={session} />
              </header>

              <SessionActivityTimeline
                activeRow={activeRow}
                buckets={buckets}
                markers={markers}
                onJump={jumpToRow}
                onScrubTo={scrubToPercent}
                scaleMinutes={scaleMinutes}
                span={span}
                throttles={session.throttles ?? []}
              />
            </div>

            <div className="sd3-tracehead">
              <span className="sd3-th-title">Session Trace</span>
              <span className="sd3-th-count">{traceCountLabel}</span>
            </div>

            <div className="sd3-trace sd3-trace-chat">
              {session.turnItems && session.turnItems.length > 0 ? (
                <SessionTrace
                  activeRow={activeRow}
                  items={session.turnItems}
                  onJump={jumpToRow}
                />
              ) : (
                <EmptyState
                  className="py-12"
                  description="No trace turns were captured for this session."
                  icon={MessageCircleIcon}
                  title="No trace events"
                />
              )}
            </div>
          </article>
        </div>
      </div>

      {commentsRailOpen ? (
        <TraceCommentsRail
          activeMarker={activeMarker}
          comments={traceComments}
          markersByRow={markersByRow}
          onJump={jumpToRow}
          onSubmitComment={submitTraceComment}
          onWidthChange={onCommentsWidthChange}
          width={commentsWidth}
        />
      ) : null}
    </div>
  );
}

function SessionPropertiesPanel({
  content,
  session,
}: Readonly<{
  content: AgentSessionDetailContent;
  session: AgentSessionDetail;
}>) {
  const [open, setOpen] = useState(false);
  const summary = getSessionPropertySummary(session);

  return (
    <section className="prd-props-section sd3-props" data-open={open}>
      {/* biome-ignore lint/a11y/useSemanticElements: FEA-1769 specifies div role="button" instead of a semantic button for design parity. */}
      <div
        className="prd-props-header"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((value) => !value);
          }
        }}
        role="button"
        tabIndex={0}
      >
        <span className="prd-props-title">Properties</span>
        <span className="prd-props-chevron">
          <ChevronRightIcon aria-hidden className="size-4" />
        </span>
      </div>

      {open ? (
        <SessionPropertiesExpanded session={session} summary={summary} />
      ) : (
        <SessionPropertiesPreview
          content={content}
          onOpen={() => setOpen(true)}
          session={session}
          summary={summary}
        />
      )}
    </section>
  );
}

function SessionActivityTimeline({
  activeRow,
  buckets,
  markers,
  onJump,
  onScrubTo,
  scaleMinutes,
  span,
  throttles,
}: Readonly<{
  activeRow: number | null;
  buckets: ActivityBucket[];
  markers: ActivityMarker[];
  onJump: (row: number, flash?: boolean) => void;
  onScrubTo: (percent: number) => void;
  scaleMinutes: number;
  span: SessionSpan;
  throttles: SessionThrottle[];
}>) {
  const [hoverBucket, setHoverBucket] = useState<HoverBucket | null>(null);
  const [hoverDot, setHoverDot] = useState<HoverDot | null>(null);
  const [dragX, setDragX] = useState<number | null>(null);
  const barsWrapRef = useRef<HTMLDivElement | null>(null);
  const scrubCleanupRef = useRef<(() => void) | null>(null);
  const maxCost = Math.max(0.01, ...buckets.map(getBucketCost));
  const cells = buildDotCells(markers, throttles, buckets.length);
  const hoverIndex = hoverBucket?.index ?? null;
  const hoveredBucket = hoverBucket == null ? null : buckets[hoverBucket.index];
  const hoveredEvents =
    hoverDot == null ? null : cells[hoverDot.bucketIndex]?.[hoverDot.color];
  const lineX = dragX ?? getRowPercent(activeRow, buckets);

  const startScrub = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const wrap = barsWrapRef.current;
      if (!wrap) {
        return;
      }
      const rect = wrap.getBoundingClientRect();

      function move(moveEvent: globalThis.PointerEvent) {
        const nextPercent = clamp(
          ((moveEvent.clientX - rect.left) / rect.width) * 100,
          0,
          100
        );
        setDragX(nextPercent);
        onScrubTo(nextPercent);
      }

      function up() {
        globalThis.document.removeEventListener("pointermove", move);
        globalThis.document.removeEventListener("pointerup", up);
        setDragX(null);
        globalThis.document.body.style.userSelect = "";
        scrubCleanupRef.current = null;
      }

      globalThis.document.addEventListener("pointermove", move);
      globalThis.document.addEventListener("pointerup", up);
      globalThis.document.body.style.userSelect = "none";
      scrubCleanupRef.current = up;
      move(event.nativeEvent);
    },
    [onScrubTo]
  );

  // Detach any still-attached scrub listeners if the bar unmounts mid-drag.
  useEffect(() => () => scrubCleanupRef.current?.(), []);

  if (buckets.length === 0) {
    return (
      <div className="sd3-actbar">
        <div className="sd3-act-head">
          <span className="sd3-act-title">Session Timeline</span>
        </div>
        <p className="text-muted-foreground text-sm">
          No activity buckets were captured for this session.
        </p>
      </div>
    );
  }

  return (
    <div className="sd3-actbar">
      <div className="sd3-act-head">
        <span className="sd3-act-title">Session Timeline</span>
      </div>
      <div className="sd3-bars2-wrap" ref={barsWrapRef}>
        <div
          className={cn("sd3-playhead", dragX != null && "dragging")}
          onPointerDown={startScrub}
          style={{ left: `${lineX}%` }}
          title="Drag to scrub the trace"
        >
          <span className="sd3-playhead-grip">
            <GripVerticalIcon aria-hidden className="size-2.5" />
          </span>
        </div>

        <div className="sd3-bars2">
          {buckets.map((bucket, index) => {
            const cost = getBucketCost(bucket);
            const idle = cost === 0;
            const height = idle
              ? 0
              : Math.max(
                  9,
                  Math.round((Math.sqrt(cost) / Math.sqrt(maxCost)) * 100)
                );
            const showLabel = !idle && cost >= maxCost * 0.16;
            return (
              <button
                aria-label={getBucketButtonLabel(bucket)}
                className={cn(
                  "sd3-bar2",
                  idle ? "idle" : "stacked",
                  hoverIndex === index && "hot"
                )}
                key={getBucketKey(bucket)}
                onClick={() => {
                  if (bucket.tl0 != null) {
                    onJump(bucket.tl0);
                  }
                }}
                onMouseEnter={(event) =>
                  setHoverBucket({
                    anchor: getTooltipAnchor(event.currentTarget),
                    index,
                  })
                }
                onMouseLeave={() => setHoverBucket(null)}
                style={{ height: `${height}%` }}
                type="button"
              >
                {showLabel ? (
                  <span className="sd3-bar2-lbl">
                    ${cost < 1 ? cost.toFixed(1) : Math.round(cost)}
                  </span>
                ) : null}
                {idle ? null : (
                  <>
                    <i
                      className="cb-cache"
                      style={{ height: `${(bucket.cCache / cost) * 100}%` }}
                    />
                    <i
                      className="cb-out"
                      style={{ height: `${(bucket.cOut / cost) * 100}%` }}
                    />
                    <i
                      className="cb-in"
                      style={{ height: `${(bucket.cIn / cost) * 100}%` }}
                    />
                  </>
                )}
              </button>
            );
          })}
        </div>

        <div className="sd3-drail">
          {cells.map((cell, bucketIndex) => (
            <div
              className="sd3-dcell"
              key={`dots-${getBucketKey(buckets[bucketIndex])}`}
            >
              {DOT_ORDER.map((color) =>
                cell[color].length > 0 ? (
                  <button
                    aria-label={`Jump to ${getDotLabel(color)}`}
                    className={cn(
                      `sd3-dot d-${color}`,
                      hoverDot?.bucketIndex === bucketIndex &&
                        hoverDot.color === color &&
                        "hot"
                    )}
                    key={color}
                    onClick={() => onJump(cell[color][0]?.tl ?? 0)}
                    onMouseEnter={(event) =>
                      setHoverDot({
                        anchor: getTooltipAnchor(event.currentTarget),
                        bucketIndex,
                        color,
                      })
                    }
                    onMouseLeave={() => setHoverDot(null)}
                    type="button"
                  />
                ) : null
              )}
            </div>
          ))}
        </div>

        {hoverBucket && hoveredBucket && hoverDot == null ? (
          <ActivityBucketTooltip
            anchor={hoverBucket.anchor}
            bucket={hoveredBucket}
          />
        ) : null}
        {hoverDot && hoveredEvents && hoveredEvents.length > 0 ? (
          <EventDotTooltip
            anchor={hoverDot.anchor}
            color={hoverDot.color}
            events={hoveredEvents}
          />
        ) : null}
      </div>
      <div className="sd3-act-axis">
        <span>{span.first}</span>
        <span className="sd3-act-mid" />
        <span title="Total session duration, rounded up to the nearest minute">
          {scaleMinutes}m
        </span>
      </div>
    </div>
  );
}

function TraceCommentsRail({
  activeMarker,
  comments,
  markersByRow,
  onJump,
  onSubmitComment,
  onWidthChange,
  width,
}: Readonly<{
  activeMarker: ActivityMarker | null;
  comments: TraceComment[];
  markersByRow: Map<number, ActivityMarker>;
  onJump: (row: number, flash?: boolean) => void;
  onSubmitComment: (body: string) => void;
  onWidthChange: (width: number) => void;
  width: number;
}>) {
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const startResize = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const handle = event.currentTarget;
      const shell = handle.closest<HTMLElement>(".sd3");
      if (!shell) {
        return;
      }
      const resizeShell = shell;
      const rail = handle.closest<HTMLElement>(".sd3-cmts");
      const startX = event.clientX;
      const railWidth = rail?.getBoundingClientRect().width;
      const startWidth = railWidth && railWidth > 0 ? railWidth : width;

      function onMove(moveEvent: globalThis.MouseEvent) {
        const max = Math.max(320, resizeShell.clientWidth * 0.5);
        const nextWidth = clamp(
          startWidth - (moveEvent.clientX - startX),
          300,
          max
        );
        resizeShell.style.setProperty("--sd3-cmts-w", `${nextWidth}px`);
        onWidthChange(nextWidth);
      }

      function onUp() {
        globalThis.document.removeEventListener("mousemove", onMove);
        globalThis.document.removeEventListener("mouseup", onUp);
        handle.classList.remove("dragging");
        globalThis.document.body.style.cursor = "";
        globalThis.document.body.style.userSelect = "";
        resizeCleanupRef.current = null;
      }

      handle.classList.add("dragging");
      globalThis.document.body.style.cursor = "col-resize";
      globalThis.document.body.style.userSelect = "none";
      globalThis.document.addEventListener("mousemove", onMove);
      globalThis.document.addEventListener("mouseup", onUp);
      resizeCleanupRef.current = onUp;
    },
    [onWidthChange, width]
  );

  // Detach any still-attached resize listeners if the panel unmounts mid-drag.
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  return (
    <aside className="sd3-cmts fp">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: FEA-1770 source keeps the resize handle mouse-only and non-focusable. */}
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: FEA-1770 source keeps the resize handle mouse-only and non-focusable. */}
      <div
        className="fp-resize"
        onMouseDown={startResize}
        title="Drag to resize"
      />
      <div className="fp-head">
        <div className="fp-head-row">
          <span className="fp-title">
            Comments <span className="fp-count">{comments.length}</span>
          </span>
          <div className="fp-head-actions">
            <button
              className="fp-icon-btn fp-sort-btn"
              title="Sort"
              type="button"
            >
              <ArrowUpDownIcon aria-hidden className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      <div className="fp-stream">
        <div className="fp-daysep">
          <span>Today</span>
        </div>
        {comments.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="font-medium text-sm">No trace comments yet</p>
            <p className="mt-1 text-muted-foreground text-xs">
              Select a timeline point to anchor the next comment.
            </p>
          </div>
        ) : (
          comments.map((comment) => (
            <TraceCommentCard
              active={comment.row === activeMarker?.tl}
              comment={comment}
              key={comment.id}
              markersByRow={markersByRow}
              onJump={onJump}
            />
          ))
        )}
      </div>

      <div className="fp-composer">
        <div className="fp-composer-hint">
          <CrosshairIcon aria-hidden className="size-3" />
          {activeMarker ? (
            <span>
              Commenting on <b>{formatStepLabel(activeMarker)}</b>
            </span>
          ) : (
            <span>Select a step to anchor your comment</span>
          )}
        </div>
        <CommentComposer
          containerClassName="fp-composer-box"
          footerClassName="fp-composer-actions"
          leadingActions={
            <div className="fp-composer-tools">
              <button
                aria-label="Attach file"
                className="fp-icon-btn"
                type="button"
              >
                <PaperclipIcon aria-hidden className="size-3.5" />
              </button>
              <button
                aria-label="Mention user"
                className="fp-icon-btn"
                type="button"
              >
                <AtSignIcon aria-hidden className="size-3.5" />
              </button>
            </div>
          }
          minHeightClassName="min-h-[64px]"
          onSubmit={onSubmitComment}
          placeholder="Comment, or @ai to ask about this moment..."
          submitLabel="Comment"
        />
      </div>
    </aside>
  );
}

function TraceCommentCard({
  active,
  comment,
  markersByRow,
  onJump,
}: Readonly<{
  active: boolean;
  comment: TraceComment;
  markersByRow: Map<number, ActivityMarker>;
  onJump: (row: number, flash?: boolean) => void;
}>) {
  const marker =
    comment.row == null ? null : (markersByRow.get(comment.row) ?? null);
  const label = marker ? formatStepLabel(marker) : comment.markerLabel;
  const jumpToComment = () => {
    if (comment.row != null) {
      onJump(comment.row);
    }
  };

  const commentCard = (
    // biome-ignore lint/a11y/noStaticElementInteractions: FEA-1770 source makes the comment card itself mouse-clickable without keyboard handlers.
    // biome-ignore lint/a11y/useKeyWithClickEvents: FEA-1770 source has no comment-card keyboard handler.
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: FEA-1770 source keeps the comment card as a non-interactive element with click-to-jump behavior.
    <div
      className={cn("fp-comment", active && "is-active")}
      onClick={jumpToComment}
    >
      <span className="fp-rail">
        <Avatar className="size-[26px]">
          <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
            AI
          </AvatarFallback>
        </Avatar>
      </span>
      <div className="fp-comment-body">
        <div className="fp-comment-head">
          <b>Draft</b>
          <span className="sd3-cmt-role">Local</span>
          <span className="fp-when">now</span>
          <span className="fp-comment-actions">
            <button
              className="fp-icon-btn"
              onClick={(event) => event.stopPropagation()}
              title="React"
              type="button"
            >
              <SmileIcon aria-hidden className="size-3" />
            </button>
            <button
              className="fp-icon-btn"
              onClick={(event) => event.stopPropagation()}
              title="Reply"
              type="button"
            >
              <CornerUpLeftIcon aria-hidden className="size-3" />
            </button>
          </span>
        </div>
        <button
          className={cn("fp-quote", active && "is-active")}
          onClick={(event) => {
            event.stopPropagation();
            jumpToComment();
          }}
          title="Jump to this step in the trace"
          type="button"
        >
          <span className="fp-quote-bar" />
          <span className="fp-quote-text">{label}</span>
        </button>
        <div className="fp-comment-text">{comment.body}</div>
      </div>
    </div>
  );

  return commentCard;
}

function PropertyValue({
  children,
  icon: Icon,
  label,
  leading,
  mono,
}: Readonly<{
  children: ReactNode;
  icon: LucideIcon | null;
  label: string;
  leading?: ReactNode;
  mono?: boolean;
}>) {
  return (
    <div className="prd-prop">
      <span className="prd-prop-label">{label}</span>
      <span className="prd-prop-value">
        {leading ?? (Icon ? <Icon aria-hidden className="size-3.5" /> : null)}
        <span className={mono ? "mono" : undefined}>{children}</span>
      </span>
    </div>
  );
}

function PullRequestPill({
  pr,
  repositoryFullName,
}: Readonly<{ pr: SessionPR; repositoryFullName: string | null }>) {
  const href = getPullRequestHref(pr, repositoryFullName);
  const content = (
    <>
      <GitPullRequestIcon aria-hidden className="size-3.5" />
      <span className="mono">{pr.num}</span>
      <span className="sd3-result-status">{pr.status}</span>
    </>
  );

  if (!href) {
    return <span className="sd3-result-pr">{content}</span>;
  }

  return (
    <a className="sd3-result-pr" href={href} rel="noreferrer" target="_blank">
      {content}
    </a>
  );
}

function ActivityBucketTooltip({
  anchor,
  bucket,
}: Readonly<{
  anchor: TooltipAnchor;
  bucket: ActivityBucket;
}>) {
  const cost = getBucketCost(bucket);
  const { placement, ref, style } = useViewportTooltipStyle(anchor);
  return (
    <ViewportTooltipPortal>
      <div
        className="sd3-tip"
        data-placement={placement}
        ref={ref}
        style={style}
      >
        <div className="sd3-tip-h">
          <b>{bucket.label}</b>
          {cost > 0 ? <span className="mono">{formatMoney(cost)}</span> : null}
        </div>
        {cost === 0 ? (
          <div className="sd3-tip-idle">
            Agent asleep | scheduled wake-up | no tokens billed
          </div>
        ) : (
          <table className="sd3-tip-tbl">
            <thead>
              <tr>
                <th>model</th>
                <th>
                  <i className="cb-cache" />
                  cache
                </th>
                <th>
                  <i className="cb-out" />
                  out
                </th>
                <th>
                  <i className="cb-in" />
                  in
                </th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(bucket.byModel).map(([model, usage]) => (
                <tr key={model}>
                  <td className="mono">{model}</td>
                  <td>{formatMoney(usage.cCache)}</td>
                  <td>{formatMoney(usage.cOut)}</td>
                  <td>{formatMoney(usage.cIn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="sd3-tip-meta">
          {bucket.total} events | {bucket.toolStart} tool calls
          {bucket.tl0 == null ? "" : " | click to open in trace"}
        </div>
      </div>
    </ViewportTooltipPortal>
  );
}

function EventDotTooltip({
  anchor,
  color,
  events,
}: Readonly<{
  anchor: TooltipAnchor;
  color: DotColor;
  events: TimelineDotEvent[];
}>) {
  const { placement, ref, style } = useViewportTooltipStyle(anchor);
  return (
    <ViewportTooltipPortal>
      <div
        className="sd3-tip sd3-tip-mk"
        data-placement={placement}
        ref={ref}
        style={style}
      >
        <div className="sd3-tip-mkhead">
          <span
            aria-hidden
            className="sd3-tip-swatch"
            style={{ background: getDotColorToken(color) }}
          />
          {getDotLabel(color)}
          {events.length > 1 ? (
            <span className="sd3-tip-mktime">{events.length} events</span>
          ) : null}
        </div>
        <div className="sd3-tip-list">
          {events.map((event) => (
            <div
              className="sd3-tip-li"
              key={`${event.kind}-${event.t}-${event.tl}`}
            >
              <span className="sd3-tip-lt mono">{event.t}</span>
              <span className="sd3-tip-lk">{event.kind}</span>
              <span className="sd3-tip-ll">{event.label}</span>
            </div>
          ))}
        </div>
        <div className="sd3-tip-meta">
          click the dot to jump to {events.length > 1 ? "the first" : "this"} in
          the trace
        </div>
      </div>
    </ViewportTooltipPortal>
  );
}

function buildActivityMarkers(session: AgentSessionDetail): ActivityMarker[] {
  if (session.markers && session.markers.length > 0) {
    return session.markers.map((marker) => ({
      ...marker,
      label: marker.label,
      tl: marker.tl,
    }));
  }

  const items = session.turnItems ?? [];
  return items
    .map((item, index) => buildTurnMarker(item, index, items.length))
    .filter((marker): marker is ActivityMarker => marker !== null);
}

function buildTurnMarker(
  item: TurnItem,
  index: number,
  total: number
): ActivityMarker | null {
  const x = total <= 1 ? 0 : (index / (total - 1)) * 100;
  switch (item.type) {
    case "prompt":
      return {
        kind: "prompt",
        x,
        t: formatMarkerTime(item.t),
        label: item.text,
        tl: item._row,
      };
    case "tools":
      return {
        kind: item.hasFail ? "fail" : "prompt",
        x,
        t: formatMarkerTime(item.t),
        label: item.summary,
        tl: item._row,
      };
    case "event":
      return {
        kind: getEventMarkerKind(item.dot),
        x,
        t: formatMarkerTime(item.t),
        label: item.tag ?? item.text,
        tl: item._row,
      };
    case "subagent":
      return {
        kind: item.status.toLowerCase().includes("fail") ? "fail" : "prompt",
        x,
        t: formatMarkerTime(item.t),
        label: item.sub,
        tl: item._row,
      };
    case "say":
      return null;
    case "idle":
    case "sessionstart":
    case "end":
      return null;
    default:
      return assertNeverTurnItem(item);
  }
}

function buildActivityBuckets(
  session: AgentSessionDetail,
  markers: ActivityMarker[]
): ActivityBucket[] {
  if (session.activityBuckets && session.activityBuckets.length > 0) {
    return session.activityBuckets;
  }

  const rows = session.turnItems ?? [];
  if (rows.length === 0) {
    return [];
  }

  const timedRows = rows.filter(hasTimedTraceRow);
  if (timedRows.length === 0) {
    return buildEvenActivityBuckets(session, rows, markers);
  }

  const firstMs = Math.min(...timedRows.map(getTurnItemMs));
  const lastMs = Math.max(...timedRows.map(getTurnItemMs));
  const spanMs = Math.max(1, lastMs - firstMs);
  const bucketCount = getFallbackBucketCount(spanMs, timedRows.length);
  const model = session.primaryModel ?? session.model ?? "model";
  const buckets = Array.from(
    { length: bucketCount },
    (_, bucketIndex): ActivityBucket => ({
      key: `time-${bucketIndex}-${Math.round(firstMs + (spanMs * bucketIndex) / bucketCount)}`,
      label: formatBucketLabel(firstMs + (spanMs * bucketIndex) / bucketCount),
      cIn: 0,
      cOut: 0,
      cCache: 0,
      total: 0,
      toolStart: 0,
      tl0: null,
      byModel: {
        [model]: {
          cIn: 0,
          cOut: 0,
          cCache: 0,
        },
      },
    })
  );

  for (const row of timedRows) {
    const bucket =
      buckets[
        getBucketIndexFromMs(getTurnItemMs(row), firstMs, spanMs, bucketCount)
      ];
    bucket.total += 1;
    if (row.type === "tools") {
      bucket.toolStart += 1;
    }
    if (bucket.tl0 == null || row._row < bucket.tl0) {
      bucket.tl0 = row._row;
    }
  }

  const totalWeight = buckets.reduce(
    (sum, bucket) => sum + getFallbackBucketWeight(bucket),
    0
  );
  const totalCost = Math.max(session.estimatedCost, 0.01);
  for (const bucket of buckets) {
    const weight = getFallbackBucketWeight(bucket);
    if (weight === 0 || totalWeight === 0) {
      continue;
    }
    const bucketCost = totalCost * (weight / totalWeight);
    applyBucketCost(bucket, model, bucketCost);
  }

  return buckets;
}

function buildDotCells(
  markers: ActivityMarker[],
  throttles: SessionThrottle[],
  bucketCount: number
): DotCell[] {
  const cells = Array.from({ length: bucketCount }, createDotCell);
  for (const marker of markers) {
    const color = getMarkerDotColor(marker.kind);
    if (color) {
      cells[getBucketIndexFromPercent(marker.x, bucketCount)][color].push({
        kind: marker.kind,
        label: marker.label,
        t: marker.t,
        tl: marker.tl,
      });
    }
  }
  for (const throttle of throttles) {
    cells[getBucketIndexFromPercent(throttle.x0, bucketCount)].r.push({
      kind: "limit",
      label: `throttled ${throttle.durMin}m, resumed ${throttle.t1}`,
      t: throttle.t0,
      tl: throttle.tl,
    });
  }
  return cells;
}

function getSessionSpan(
  session: AgentSessionDetail,
  markers: ActivityMarker[]
): SessionSpan {
  if (session.span) {
    return session.span;
  }
  return {
    first:
      markers[0]?.t ??
      safeFormatDateTime(session.startedAt) ??
      safeFormatDateTime(session.updatedAt),
    last:
      markers.at(-1)?.t ??
      safeFormatDateTime(session.endedAt ?? session.updatedAt),
  };
}

function getActiveMarker(
  markers: ActivityMarker[],
  activeRow: number | null
): ActivityMarker | null {
  if (markers.length === 0) {
    return null;
  }
  if (activeRow == null) {
    return markers[0] ?? null;
  }
  const exactMarker = markers.find((marker) => marker.tl === activeRow);
  if (exactMarker) {
    return exactMarker;
  }
  for (let index = markers.length - 1; index >= 0; index -= 1) {
    const marker = markers[index];
    if (marker && marker.tl <= activeRow) {
      return marker;
    }
  }
  return markers[0] ?? null;
}

function getRowPercent(
  activeRow: number | null,
  buckets: ActivityBucket[]
): number {
  if (buckets.length === 0 || activeRow == null) {
    return 0;
  }
  let bucketIndex = 0;
  for (const [index, bucket] of buckets.entries()) {
    if (bucket.tl0 != null && bucket.tl0 <= activeRow) {
      bucketIndex = index;
    }
  }
  return ((bucketIndex + 0.5) / buckets.length) * 100;
}

function getBucketIndexFromPercent(
  percent: number,
  bucketCount: number
): number {
  if (bucketCount <= 1) {
    return 0;
  }
  return clamp(Math.floor((percent / 100) * bucketCount), 0, bucketCount - 1);
}

function getBucketCost(bucket: ActivityBucket): number {
  return bucket.cIn + bucket.cOut + bucket.cCache;
}

function getMarkerDotColor(kind: ActivityMarker["kind"]): DotColor | null {
  if (kind === "commit" || kind === "pr") {
    return "g";
  }
  if (kind === "fail" || kind === "limit") {
    return "r";
  }
  if (kind === "prompt" || kind === "frust") {
    return "b";
  }
  return null;
}

function getDotColorToken(color: DotColor): string {
  if (color === "g") {
    return "var(--success)";
  }
  if (color === "r") {
    return "var(--destructive)";
  }
  return "var(--primary)";
}

function getDotLabel(color: DotColor): string {
  if (color === "g") {
    return "Commits & PRs";
  }
  if (color === "r") {
    return "Failures & limits";
  }
  return "Human steering";
}

function createDotCell(): DotCell {
  return { b: [], g: [], r: [] };
}

function hasTraceRow(
  item: TurnItem
): item is TurnItem & { _row: number; t: string } {
  return "_row" in item && "t" in item;
}

function formatStepLabel(marker: ActivityMarker): string {
  return `${marker.t} | ${marker.label}`;
}

function formatMarkerTime(value: unknown): string {
  if (value instanceof Date) {
    return formatTime(value, { includeSeconds: true });
  }
  if (typeof value !== "string") {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return formatTime(date, { includeSeconds: true });
}

function formatMoney(value: number): string {
  return `$${value < 0.01 ? "0.00" : value.toFixed(2)}`;
}

function getPrCount(session: AgentSessionDetail): number {
  return session.prsMerged ?? session.prs?.length ?? 0;
}

function getTraceCountLabel(session: AgentSessionDetail): string {
  const rowCount = session.turnItems?.length;
  if (rowCount != null) {
    const suffix = rowCount === 1 ? "event" : "events";
    return `${rowCount.toLocaleString()} ${suffix}`;
  }
  const eventCount = session.events.length;
  const suffix = eventCount === 1 ? "event" : "events";
  return `${eventCount.toLocaleString()} ${suffix}`;
}

function getStatusLabel(state: AgentSessionDetail["state"]): string {
  if (state === AgentSessionState.Completed) {
    return "Completed";
  }
  if (state === AgentSessionState.Running) {
    return "Running";
  }
  if (state === AgentSessionState.PendingApproval) {
    return "Awaiting your approval";
  }
  if (state === AgentSessionState.Blocked) {
    return "Blocked";
  }
  if (state === AgentSessionState.InReview) {
    return "In review";
  }
  return state ?? "Unknown";
}

function getStatusColor(state: AgentSessionDetail["state"]): string {
  if (state === AgentSessionState.Completed) {
    return "var(--success)";
  }
  if (state === AgentSessionState.PendingApproval) {
    return "var(--warning)";
  }
  if (state === AgentSessionState.Blocked) {
    return "var(--destructive)";
  }
  if (state === AgentSessionState.InReview) {
    return "var(--info)";
  }
  return "var(--ai)";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function assertNeverTurnItem(item: never): null {
  return item;
}

function getTooltipAnchor(element: HTMLElement): TooltipAnchor {
  const rect = element.getBoundingClientRect();
  return {
    bottom: rect.bottom,
    height: rect.height,
    left: rect.left,
    right: rect.right,
    top: rect.top,
    width: rect.width,
  };
}

function useViewportTooltipStyle(anchor: TooltipAnchor) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>(() =>
    getHiddenTooltipStyle(anchor)
  );
  const [placement, setPlacement] = useState<ViewportTooltipPlacement>("below");

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    const rect = node.getBoundingClientRect();
    const measured = getMeasuredTooltipStyle(anchor, rect.width, rect.height);
    setPlacement(measured.placement);
    setStyle(measured.style);
  }, [anchor]);

  return { placement, ref, style };
}

function ViewportTooltipPortal({
  children,
}: Readonly<{ children: ReactNode }>) {
  if (globalThis.document === undefined) {
    return null;
  }

  return createPortal(children, globalThis.document.body);
}

function getHiddenTooltipStyle(anchor: TooltipAnchor): CSSProperties {
  return {
    bottom: "auto",
    left: anchor.left,
    position: "fixed",
    top: anchor.bottom + TOOLTIP_ANCHOR_GAP,
    transform: "none",
    visibility: "hidden",
  };
}

function getMeasuredTooltipStyle(
  anchor: TooltipAnchor,
  tooltipWidth: number,
  tooltipHeight: number
): { placement: ViewportTooltipPlacement; style: CSSProperties } {
  const viewportWidth = globalThis.innerWidth;
  const viewportHeight = globalThis.innerHeight;
  const maxLeft = Math.max(
    TOOLTIP_VIEWPORT_PADDING,
    viewportWidth - tooltipWidth - TOOLTIP_VIEWPORT_PADDING
  );
  const centerLeft = anchor.left + anchor.width / 2 - tooltipWidth / 2;
  const left = clamp(centerLeft, TOOLTIP_VIEWPORT_PADDING, maxLeft);
  const topAbove = anchor.top - tooltipHeight - TOOLTIP_ANCHOR_GAP;
  const topBelow = anchor.bottom + TOOLTIP_ANCHOR_GAP;
  const placement: ViewportTooltipPlacement =
    topAbove >= TOOLTIP_VIEWPORT_PADDING ? "above" : "below";
  const rawTop = placement === "above" ? topAbove : topBelow;
  const maxTop = Math.max(
    TOOLTIP_VIEWPORT_PADDING,
    viewportHeight - tooltipHeight - TOOLTIP_VIEWPORT_PADDING
  );

  return {
    placement,
    style: {
      bottom: "auto",
      left,
      maxHeight: `calc(100vh - ${TOOLTIP_VIEWPORT_PADDING * 2}px)`,
      position: "fixed",
      top: clamp(rawTop, TOOLTIP_VIEWPORT_PADDING, maxTop),
      transform: "none",
      visibility: "visible",
    },
  };
}

type ActivityMarker = {
  kind: "commit" | "fail" | "frust" | "limit" | "pr" | "prompt";
  label: string;
  t: string;
  tl: number;
  x: number;
  illustrative?: boolean;
};

type TimelineDotEvent = Omit<ActivityMarker, "x">;

type DotColor = "b" | "g" | "r";

type TooltipAnchor = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
};

type ViewportTooltipPlacement = "above" | "below";

type HoverBucket = {
  anchor: TooltipAnchor;
  index: number;
};

type HoverDot = {
  anchor: TooltipAnchor;
  bucketIndex: number;
  color: DotColor;
};

type DotCell = Record<DotColor, TimelineDotEvent[]>;

type TraceComment = {
  id: string;
  body: string;
  markerLabel: string;
  row: number | null;
};

type SessionPropertySummary = {
  model: string;
  prs: SessionPR[];
  repo: string;
  statusLabel: string;
};

function SessionPropertiesExpanded({
  session,
  summary,
}: Readonly<{
  session: AgentSessionDetail;
  summary: SessionPropertySummary;
}>) {
  return (
    <div className="prd-props">
      <PropertyValue icon={CheckCircle2Icon} label="Status">
        {summary.statusLabel}
      </PropertyValue>
      <PropertyValue icon={TerminalIcon} label="Harness">
        {session.harness}
      </PropertyValue>
      <PropertyValue icon={FolderGit2Icon} label="Repository" mono>
        {summary.repo}
      </PropertyValue>
      <PropertyValue icon={SquareCheckIcon} label="Artifacts" mono>
        {session.issues?.join(", ") || session.issueId || "None"}
      </PropertyValue>
      <PropertyValue icon={ClockIcon} label="Duration">
        {session.wallClock ?? "Unknown"} wall |{" "}
        {session.activeAgent ?? "unknown"} active |{" "}
        {session.waitingUser ?? "0m"} idle
      </PropertyValue>
      <PropertyValue icon={HashIcon} label="Tokens" mono>
        {(session.tokensIn ?? 0).toLocaleString()} in |{" "}
        {(session.tokensOut ?? 0).toLocaleString()} out |{" "}
        {(session.cache ?? 0).toLocaleString()} cache read |{" "}
        {(session.cacheWrite ?? 0).toLocaleString()} cache write
      </PropertyValue>
      <PropertyValue icon={GaugeIcon} label="Autonomy">
        {getAutonomyLabel(session.autonomy)} | {session.autonomy ?? 0}/100
      </PropertyValue>
      <PropertyValue icon={BotIcon} label="Model" mono>
        {summary.model}
      </PropertyValue>
      <PropertyValue icon={GitBranchIcon} label="Branch" mono>
        {session.branch ?? "Unknown"}
      </PropertyValue>
      <div className="prd-prop">
        <span className="prd-prop-label">Pull requests</span>
        <div
          className="prd-prop-value sd3-prs-value"
          style={{ cursor: "default" }}
        >
          {summary.prs.length === 0 ? (
            <span>None</span>
          ) : (
            summary.prs.map((pr) => (
              <PullRequestPill
                key={pr.num}
                pr={pr}
                repositoryFullName={getSessionRepositoryFullName(session)}
              />
            ))
          )}
          <span className="sd3-out-diff">
            <b className="add">+{session.linesAdded ?? 0}</b>{" "}
            <b className="del">-{session.linesRemoved ?? 0}</b>
          </span>
        </div>
      </div>
      <PropertyValue icon={CircleDollarSignIcon} label="Cost" mono>
        {session.cost ?? "$0.00"}
      </PropertyValue>
      <PropertyValue icon={ActivityIcon} label="Work">
        {session.turns ?? session.turnItems?.length ?? 0} turns |{" "}
        {session.toolCallsTotal ?? session.toolUseCount} tool calls |{" "}
        {session.steeringEpisodes ?? 0} steers
      </PropertyValue>
    </div>
  );
}

function SessionPropertiesPreview({
  content,
  onOpen,
  session,
  summary,
}: Readonly<{
  content: AgentSessionDetailContent;
  onOpen: () => void;
  session: AgentSessionDetail;
  summary: SessionPropertySummary;
}>) {
  return (
    <button className="sd3-props-preview" onClick={onOpen} type="button">
      <span className="sd3-pp">
        <span
          aria-hidden
          className="sd3-status-dot"
          style={{ background: getStatusColor(session.state) }}
        />
        {summary.statusLabel}
      </span>
      <span className="sd3-pp mono">
        <BotIcon aria-hidden className="size-3" />
        {summary.model}
      </span>
      <span className="sd3-pp mono">
        <FolderGit2Icon aria-hidden className="size-3" />
        {summary.repo}
      </span>
      <span className="sd3-pp mono">
        <CircleDollarSignIcon aria-hidden className="size-3" />
        {content.metrics[2]?.value ?? session.cost ?? "$0.00"}
      </span>
      <span className="sd3-pp">
        <GitPullRequestIcon aria-hidden className="size-3" />
        {getPrCount(session)} PRs merged
      </span>
    </button>
  );
}

function getSessionPropertySummary(
  session: AgentSessionDetail
): SessionPropertySummary {
  return {
    model: session.primaryModel ?? session.model ?? "Unknown model",
    prs: session.prs ?? [],
    repo:
      session.repo ??
      session.repositoryFullName ??
      session.cwd ??
      "Unknown repo",
    statusLabel: getStatusLabel(session.state),
  };
}

function getPullRequestHref(
  pr: SessionPR,
  repositoryFullName: string | null
): string | null {
  const repo = normalizeRepositoryFullName(repositoryFullName);
  const prNumber = normalizePullRequestNumber(pr.num);

  if (!(repo && prNumber)) {
    return null;
  }

  return `https://github.com/${repo}/pull/${prNumber}`;
}

function getSessionRepositoryFullName(
  session: AgentSessionDetail
): string | null {
  return session.repositoryFullName ?? session.repo ?? null;
}

function normalizeRepositoryFullName(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!(trimmed && REPOSITORY_FULL_NAME_REGEX.test(trimmed))) {
    return null;
  }

  return trimmed;
}

function normalizePullRequestNumber(value: number | string): string | null {
  const raw = String(value).trim();
  if (!PULL_REQUEST_NUMBER_REGEX.test(raw)) {
    return null;
  }

  return raw;
}

function getBucketButtonLabel(bucket: ActivityBucket): string {
  if (bucket.tl0 == null) {
    return `Activity bucket ${bucket.label}`;
  }
  return `Jump to activity bucket ${bucket.label}`;
}

function getBucketKey(bucket: ActivityBucket | undefined): string {
  if (!bucket) {
    return "missing-bucket";
  }
  if (bucket.key) {
    return bucket.key;
  }
  return [
    bucket.label,
    bucket.tl0 ?? "idle",
    bucket.total,
    bucket.toolStart,
    bucket.cCache,
    bucket.cOut,
    bucket.cIn,
  ].join(":");
}

function getEventMarkerKind(dot: string | undefined): ActivityMarker["kind"] {
  if (dot === "g") {
    return "commit";
  }
  if (dot === "r") {
    return "fail";
  }
  return "prompt";
}

function buildEvenActivityBuckets(
  session: AgentSessionDetail,
  rows: TurnItem[],
  markers: ActivityMarker[]
): ActivityBucket[] {
  const bucketCount = Math.min(16, Math.max(4, rows.length));
  const bucketSize = Math.ceil(rows.length / bucketCount);
  const cost = Math.max(session.estimatedCost, MIN_ACTIVITY_COST);
  const costPerRow = cost / rows.length;
  const model = session.primaryModel ?? session.model ?? "model";
  return Array.from({ length: bucketCount }, (_, bucketIndex) => {
    const firstIndex = bucketIndex * bucketSize;
    const bucketRows = rows.slice(firstIndex, firstIndex + bucketSize);
    const firstRow = bucketRows.find(hasTraceRow);
    const toolStart = bucketRows.filter((item) => item.type === "tools").length;
    const bucketCost = bucketRows.length * costPerRow;
    const idle = bucketRows.length === 0;
    const bucket: ActivityBucket = {
      key: `even-${bucketIndex}-${firstIndex}`,
      label: firstRow ? formatMarkerTime(firstRow.t) : "",
      cIn: 0,
      cOut: 0,
      cCache: 0,
      total: bucketRows.length,
      toolStart,
      tl0: firstRow?._row ?? markers[bucketIndex]?.tl ?? null,
      byModel: {
        [model]: {
          cIn: 0,
          cOut: 0,
          cCache: 0,
        },
      },
    };
    if (!idle) {
      applyBucketCost(bucket, model, bucketCost);
    }
    return bucket;
  });
}

function hasTimedTraceRow(item: TurnItem): item is TurnItem & {
  _row: number;
  t: string;
} {
  return hasTraceRow(item) && Number.isFinite(getTurnItemMs(item));
}

function getTurnItemMs(item: TurnItem): number {
  if ("tMs" in item && typeof item.tMs === "number") {
    return item.tMs;
  }
  if (!("t" in item) || typeof item.t !== "string") {
    return Number.NaN;
  }
  const parsed = Date.parse(item.t);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function getFallbackBucketCount(spanMs: number, rowCount: number): number {
  if (spanMs >= DAY_MS) {
    return 48;
  }
  if (spanMs >= FOUR_HOURS_MS) {
    return 32;
  }
  return Math.min(16, Math.max(4, rowCount));
}

function formatBucketLabel(value: number): string {
  return formatTime(new Date(value));
}

function getBucketIndexFromMs(
  value: number,
  firstMs: number,
  spanMs: number,
  bucketCount: number
): number {
  return clamp(
    Math.floor(((value - firstMs) / spanMs) * bucketCount),
    0,
    bucketCount - 1
  );
}

function getFallbackBucketWeight(bucket: ActivityBucket): number {
  if (bucket.total === 0) {
    return 0;
  }
  return bucket.total + bucket.toolStart * 3;
}

function applyBucketCost(
  bucket: ActivityBucket,
  model: string,
  bucketCost: number
) {
  bucket.cIn = bucketCost * ACTIVITY_COST_INPUT_RATIO;
  bucket.cOut = bucketCost * ACTIVITY_COST_OUTPUT_RATIO;
  bucket.cCache = bucketCost * ACTIVITY_COST_CACHE_RATIO;
  bucket.byModel[model] = {
    cIn: bucket.cIn,
    cOut: bucket.cOut,
    cCache: bucket.cCache,
  };
}

const DEFAULT_COMMENTS_RAIL_WIDTH = 360;
const DOT_ORDER: DotColor[] = ["b", "g", "r"];
const TOOLTIP_VIEWPORT_PADDING = 12;
const TOOLTIP_ANCHOR_GAP = 8;
const DAY_MS = 86_400_000;
const FOUR_HOURS_MS = 14_400_000;
const MIN_ACTIVITY_COST = 0.01;
const ACTIVITY_COST_INPUT_RATIO = 0.08;
const ACTIVITY_COST_OUTPUT_RATIO = 0.23;
const ACTIVITY_COST_CACHE_RATIO = 0.69;
const PULL_REQUEST_NUMBER_REGEX = /^[1-9]\d*$/;
const REPOSITORY_FULL_NAME_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
