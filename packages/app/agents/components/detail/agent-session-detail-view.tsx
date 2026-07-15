"use client";

import {
  type ActivityBucket,
  type AgentSessionDetail,
  AgentSessionState,
  type SessionPR,
  type SessionSpan,
  type SessionThrottle,
  type SessionTimelineEvent,
  type SessionTraceThrottleSource,
  type SyncedAgentSessionEvent,
  type TurnItem,
} from "@repo/api/src/types/agent-session";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useLocalStorageState } from "@repo/app/shared/hooks/use-local-storage-state";
import { computeActiveTraceRow } from "@repo/app/shared/lib/active-trace-row";
import { formatTime } from "@repo/app/shared/lib/date-utils";
import { SESSION_COMMENTS_RAIL_COLLAPSE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { getDurationScaleMinutes } from "@repo/app/shared/lib/format-utils";
import { Card, CardContent } from "@repo/design-system/components/ui/card";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { useCopyToClipboard } from "@repo/design-system/hooks/use-copy-to-clipboard";
import { activateOnEnterOrSpace } from "@repo/design-system/lib/keyboard-activation";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import {
  ActivityIcon,
  AlertCircleIcon,
  ArrowLeftIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleDollarSignIcon,
  ClockIcon,
  FingerprintIcon,
  FolderGit2Icon,
  GaugeIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  HashIcon,
  type LucideIcon,
  MessageSquareIcon,
  TerminalIcon,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
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
import { SessionTranscriptPanel } from "./session-transcript-panel";
import type { TraceCommentItem, TraceTextAnchor } from "./trace-comments";
import { TraceCommentsRail } from "./trace-comments-rail";
import { useTraceComments } from "./use-trace-comments";

/** Shared web and desktop session detail body for transcript-first review. */
export type AgentSessionDetailViewProps = {
  session?: AgentSessionDetail;
  isLoading: boolean;
  backHref: string;
  /** Caller-controlled comments rail visibility for surfaces without durable comments. */
  commentsRailOpen?: boolean;
  /**
   * FEA-2717 Task 5: which transcript file the conversation region renders —
   * `main` (default) or a `subagent:{id}` sidechain from the `?file=` deep link.
   */
  transcriptFileKey?: string;
  /**
   * Builds a deep link to a given transcript file on this session, enabling the
   * file switcher. Supplied by the route shell (it owns URL construction);
   * omitted on surfaces without routing.
   */
  buildTranscriptFileHref?: (fileKey: string) => string;
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
  transcriptFileKey,
  buildTranscriptFileHref,
}: AgentSessionDetailViewProps) {
  const content = useMemo(
    () => (session ? buildSessionDetailContent(session) : null),
    [session]
  );
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [commentsWidth, setCommentsWidth] = useState(
    DEFAULT_COMMENTS_RAIL_WIDTH
  );
  // Persist the collapse preference alongside the app's other UI prefs so it is
  // remembered across navigation and app restart (FEA-2479).
  const [commentsCollapsed, setCommentsCollapsed] = useLocalStorageState(
    COMMENTS_RAIL_COLLAPSED_KEY,
    false
  );
  const commentsCollapseEnabled = useFeatureFlagEnabled(
    SESSION_COMMENTS_RAIL_COLLAPSE_FEATURE_FLAG_KEY
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
      buildTranscriptFileHref={buildTranscriptFileHref}
      commentsCollapsed={commentsCollapsed}
      commentsCollapseEnabled={commentsCollapseEnabled}
      commentsRailOpen={commentsRailOpen}
      commentsWidth={commentsWidth}
      content={content}
      key={session.id}
      onActiveRowChange={setActiveRow}
      onCommentsCollapsedChange={setCommentsCollapsed}
      onCommentsWidthChange={setCommentsWidth}
      session={session}
      transcriptFileKey={transcriptFileKey}
    />
  );
}

function SessionDetailWorkspace({
  activeRow,
  buildTranscriptFileHref,
  commentsCollapseEnabled,
  commentsCollapsed,
  commentsWidth,
  commentsRailOpen,
  content,
  onActiveRowChange,
  onCommentsCollapsedChange,
  onCommentsWidthChange,
  session,
  transcriptFileKey,
}: Readonly<{
  activeRow: number | null;
  buildTranscriptFileHref?: (fileKey: string) => string;
  commentsCollapseEnabled: boolean;
  commentsCollapsed: boolean;
  commentsWidth: number;
  commentsRailOpen: boolean;
  content: AgentSessionDetailContent;
  onActiveRowChange: (row: number | null) => void;
  onCommentsCollapsedChange: (collapsed: boolean) => void;
  onCommentsWidthChange: (width: number) => void;
  session: AgentSessionDetail;
  transcriptFileKey?: string;
}>) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const ignoreNextTraceScrollRef = useRef(false);
  const markers = useMemo(() => buildActivityMarkers(session), [session]);
  const limitDotEvents = useMemo(() => buildLimitDotEvents(session), [session]);
  const buckets = useMemo(
    () => buildActivityBuckets(session, markers),
    [markers, session]
  );
  const span = getSessionSpan(session, markers);
  const scaleMinutes = getDurationScaleMinutes(
    session.startedAt,
    session.endedAt ?? session.updatedAt
  );
  const traceCountLabel = getTraceCountLabel(session);

  const cancelPendingTraceScroll = useCallback(() => {
    if (rafRef.current === null) {
      return;
    }
    globalThis.cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  useEffect(() => cancelPendingTraceScroll, [cancelPendingTraceScroll]);

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
    const previousScrollTop = scroller.scrollTop;
    const nextScrollTop =
      previousScrollTop + targetRect.top - scrollRect.top - offset;
    if (Math.abs(nextScrollTop - previousScrollTop) > 0.5) {
      ignoreNextTraceScrollRef.current = true;
      scroller.scrollTop = nextScrollTop;
      if (Math.abs(scroller.scrollTop - previousScrollTop) <= 0.5) {
        ignoreNextTraceScrollRef.current = false;
      }
    }
    if (flash) {
      target.classList.remove("st-flash");
      target.getBoundingClientRect();
      target.classList.add("st-flash");
    }
  }, []);

  const jumpToRow = useCallback(
    (row: number, flash = true) => {
      cancelPendingTraceScroll();
      onActiveRowChange(row);
      scrollToTraceRow(row, flash);
    },
    [cancelPendingTraceScroll, onActiveRowChange, scrollToTraceRow]
  );

  const {
    activeAnchor: activeTraceCommentAnchor,
    comments: traceComments,
    deleteTraceComment,
    jumpToTraceComment,
    replyToTraceComment,
    submitTraceComment,
    updateTraceComment,
  } = useTraceComments({
    target: { type: "session", id: session.id },
    onJumpToRow: jumpToRow,
  });

  // View-scoped override that re-opens a collapsed rail without touching the
  // saved preference. Resets per session (this component is keyed by session.id).
  const [commentsRevealed, setCommentsRevealed] = useState(false);

  const collapseCommentsRail = useCallback(() => {
    setCommentsRevealed(false);
    onCommentsCollapsedChange(true);
  }, [onCommentsCollapsedChange]);

  const expandCommentsRail = useCallback(() => {
    onCommentsCollapsedChange(false);
  }, [onCommentsCollapsedChange]);

  // FEA-2479: the page header's "Show comments rail" toggle is authoritative.
  // When the caller flips commentsRailOpen false→true, drop any stale persisted
  // collapse preference so the header toggle always yields the full panel rather
  // than being silently overridden by a rail the reader collapsed on a previous
  // visit. Keyed on the prop and guarded by a ref so we only react to the
  // false→true edge — not to the inline collapse control toggling the pref while
  // the rail stays open.
  const previousRailOpenRef = useRef(commentsRailOpen);
  useEffect(() => {
    const wasOpen = previousRailOpenRef.current;
    previousRailOpenRef.current = commentsRailOpen;
    if (commentsRailOpen && !wasOpen) {
      setCommentsRevealed(false);
      onCommentsCollapsedChange(false);
    }
  }, [commentsRailOpen, onCommentsCollapsedChange]);

  // FEA-2479/FEA-2480: anchoring a new comment must re-open a collapsed rail so
  // the reader sees where their note lands. Wrap submit rather than the inline
  // composer so an in-progress draft is never lost to the collapse. Reveal only
  // once the comment actually persists (mutation onSuccess) — a failed submit
  // must not pop open a rail the reader chose to collapse. The reveal is
  // transient; it never overwrites the reader's saved collapse preference.
  const submitTraceCommentAndReveal = useCallback(
    (draft: Parameters<typeof submitTraceComment>[0]) => {
      submitTraceComment(draft, {
        onSuccess: () => setCommentsRevealed(true),
      });
    },
    [submitTraceComment]
  );

  const handleTraceScroll = useCallback(() => {
    if (ignoreNextTraceScrollRef.current) {
      ignoreNextTraceScrollRef.current = false;
      return;
    }
    if (rafRef.current !== null) {
      return;
    }
    rafRef.current = globalThis.requestAnimationFrame(() => {
      rafRef.current = null;
      // Shared with the Branch detail page so both timelines agree on the active
      // row (and share the scroll-to-top reset).
      const row = computeActiveTraceRow({
        rowSelector: ".st [data-row]",
        scroller: scrollRef.current,
        stickySelectors: [".sd3-stickyhead.is-sticky"],
      });
      if (row != null) {
        onActiveRowChange(row);
      }
    });
  }, [onActiveRowChange]);

  const commentsRail = renderCommentsRail({
    activeRow,
    collapseEnabled: commentsCollapseEnabled,
    collapsed: commentsCollapsed && !commentsRevealed,
    comments: traceComments,
    onCollapse: collapseCommentsRail,
    onDelete: deleteTraceComment,
    onExpand: expandCommentsRail,
    onJump: jumpToTraceComment,
    onReply: replyToTraceComment,
    onUpdate: updateTraceComment,
    onWidthChange: onCommentsWidthChange,
    open: commentsRailOpen,
    width: commentsWidth,
  });

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
                limitDotEvents={limitDotEvents}
                markers={markers}
                onJump={jumpToRow}
                scaleMinutes={scaleMinutes}
                span={span}
              />
            </div>

            <div className="sd3-tracehead">
              <span className="sd3-th-title">Session Trace</span>
              <span className="sd3-th-count">{traceCountLabel}</span>
            </div>

            <div className="sd3-trace sd3-trace-chat">
              {/*
               * FEA-2717: cloud-preferred, two-phase conversation. The metadata
               * panels above render immediately from the detail response; this
               * panel hydrates the conversation from the archived cloud
               * transcript and surfaces the FR8 availability states, falling back
               * to the DB-backed `turnItems` until FEA-2718 removes that path.
               */}
              <SessionTranscriptPanel
                activeRow={activeRow}
                buildTranscriptFileHref={buildTranscriptFileHref}
                fallbackItems={session.turnItems}
                fileKey={transcriptFileKey}
                highlightAnchor={activeTraceCommentAnchor}
                onJump={jumpToRow}
                onSubmitTraceComment={submitTraceCommentAndReveal}
                session={session}
              />
            </div>
          </article>
        </div>
      </div>

      {commentsRail}
    </div>
  );
}

/** Renders the right-side comments surface: full rail, collapsed handle, or nothing. */
function renderCommentsRail({
  activeRow,
  collapseEnabled,
  collapsed,
  comments,
  onCollapse,
  onDelete,
  onExpand,
  onJump,
  onReply,
  onUpdate,
  onWidthChange,
  open,
  width,
}: Readonly<{
  activeRow: number | null;
  collapseEnabled: boolean;
  collapsed: boolean;
  comments: readonly TraceCommentItem[];
  onCollapse: () => void;
  onDelete: (commentId: string) => void;
  onExpand: () => void;
  onJump: (row: number, flash?: boolean, anchor?: TraceTextAnchor) => void;
  onReply: (commentId: string, draft: { body: string }) => void;
  onUpdate: (commentId: string, update: { body: string }) => void;
  onWidthChange: (width: number) => void;
  open: boolean;
  width: number;
}>): ReactNode {
  if (!open) {
    return null;
  }
  // Flag off (FEA-2479): keep the rail permanently open with no collapse control.
  if (collapseEnabled && collapsed) {
    return (
      <CollapsedCommentsHandle count={comments.length} onExpand={onExpand} />
    );
  }
  return (
    <TraceCommentsRail
      activeRow={activeRow}
      comments={comments}
      onCollapse={collapseEnabled ? onCollapse : undefined}
      onDelete={onDelete}
      onJump={onJump}
      onReply={onReply}
      onUpdate={onUpdate}
      onWidthChange={onWidthChange}
      width={width}
    />
  );
}

/**
 * Slim re-open affordance shown when the comments rail is collapsed (FEA-2479).
 * Stays pinned to the right edge so the toggle is reachable on small desktop
 * windows.
 */
function CollapsedCommentsHandle({
  count,
  onExpand,
}: Readonly<{ count: number; onExpand: () => void }>) {
  return (
    <aside className="sd3-cmts-collapsed">
      <button
        aria-label="Show comments panel"
        className="sd3-cmts-reopen"
        onClick={onExpand}
        title="Show comments"
        type="button"
      >
        <MessageSquareIcon aria-hidden className="size-4" />
        {count > 0 ? (
          <span className="sd3-cmts-reopen-count">{count}</span>
        ) : null}
      </button>
    </aside>
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
        onKeyDown={activateOnEnterOrSpace(() => setOpen((value) => !value))}
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
  limitDotEvents,
  markers,
  onJump,
  scaleMinutes,
  span,
}: Readonly<{
  activeRow: number | null;
  buckets: ActivityBucket[];
  limitDotEvents: ActivityMarker[];
  markers: ActivityMarker[];
  onJump: (row: number, flash?: boolean) => void;
  scaleMinutes: number;
  span: SessionSpan;
}>) {
  const [hoverBucket, setHoverBucket] = useState<HoverBucket | null>(null);
  const [hoverDot, setHoverDot] = useState<HoverDot | null>(null);
  const maxCost = Math.max(0.01, ...buckets.map(getBucketCost));
  const cells = buildDotCells(markers, limitDotEvents, buckets.length);
  const hoverIndex = hoverBucket?.index ?? null;
  const hoveredBucket = hoverBucket == null ? null : buckets[hoverBucket.index];
  const hoveredEvents =
    hoverDot == null ? null : cells[hoverDot.bucketIndex]?.[hoverDot.color];
  // Read-only "you are here" position; null until the reader scrolls or jumps.
  const herePercent =
    activeRow == null ? null : getRowPercent(activeRow, buckets);

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
      <div className="sd3-bars2-wrap">
        {herePercent == null ? null : (
          <div
            aria-hidden
            className="tl-here"
            style={{ left: `${herePercent}%` }}
          />
        )}
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

function PropertyValue({
  children,
  copyValue,
  icon: Icon,
  label,
  leading,
  mono,
}: Readonly<{
  children: ReactNode;
  copyValue?: string;
  icon: LucideIcon | null;
  label: string;
  leading?: ReactNode;
  mono?: boolean;
}>) {
  const title = typeof children === "string" ? children : undefined;
  const valueContent = (
    <>
      {leading ?? (Icon ? <Icon aria-hidden className="size-3.5" /> : null)}
      <span className={mono ? "mono" : undefined} title={title}>
        {children}
      </span>
    </>
  );

  return (
    <div className="prd-prop">
      <span className="prd-prop-label">{label}</span>
      {copyValue ? (
        <CopyablePropertyValue
          ariaLabel={`Copy ${label.toLowerCase()}`}
          copiedToastMessage={`${label} copied`}
          value={copyValue}
        >
          {valueContent}
        </CopyablePropertyValue>
      ) : (
        <span className="prd-prop-value">{valueContent}</span>
      )}
    </div>
  );
}

function CopyablePropertyValue({
  ariaLabel,
  children,
  copiedToastMessage,
  value,
}: Readonly<{
  ariaLabel: string;
  children: ReactNode;
  copiedToastMessage: string;
  value: string;
}>) {
  const [copied, copyValue] = useCopyToClipboard();
  const copy = useCallback(() => {
    copyValue(value)
      .then((success) => {
        if (success) {
          toast.success(copiedToastMessage);
        }
      })
      .catch(() => undefined);
  }, [copiedToastMessage, copyValue, value]);
  const copiedAriaLabel = ariaLabel.startsWith("Copy ")
    ? `Copied ${ariaLabel.slice(5)}`
    : `${ariaLabel} copied`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={copied ? copiedAriaLabel : ariaLabel}
          className="prd-prop-value"
          onClick={copy}
          type="button"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm break-all text-left font-mono">
        {value}
      </TooltipContent>
    </Tooltip>
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

export function buildActivityMarkers(
  session: AgentSessionDetail
): ActivityMarker[] {
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

function buildLimitDotEvents(session: AgentSessionDetail): ActivityMarker[] {
  const explicitThrottles = buildExplicitThrottleLimitDots(session);
  if (explicitThrottles.length > 0) {
    return dedupeLimitDotEvents(explicitThrottles);
  }

  return dedupeLimitDotEvents([
    ...buildThrottleSourceLimitDots(session),
    ...buildTimelineLimitDots(session),
    ...buildSessionEventLimitDots(session),
    ...buildTurnItemLimitDots(session),
  ]);
}

function buildExplicitThrottleLimitDots(
  session: AgentSessionDetail
): ActivityMarker[] {
  return (session.throttles ?? []).map((throttle) => {
    const x = clampPercent(throttle.x0);
    return {
      kind: "limit",
      label: formatThrottleLimitLabel(throttle),
      t: formatMarkerTime(throttle.t0),
      tl: resolveLimitTraceRow(session, throttle.t0, throttle.tl, x),
      x,
    };
  });
}

function buildThrottleSourceLimitDots(
  session: AgentSessionDetail
): ActivityMarker[] {
  return (session.throttleSources ?? []).map((source, index) => {
    const x = getLimitDotPercent(session, source.observedAt, index);
    return {
      kind: "limit",
      label: formatThrottleSourceLimitLabel(source),
      t: formatMarkerTime(source.observedAt),
      tl: resolveLimitTraceRow(session, source.observedAt, index, x),
      x,
    };
  });
}

function buildTimelineLimitDots(session: AgentSessionDetail): ActivityMarker[] {
  return (session.timeline ?? []).flatMap((event, index) => {
    const label = getTimelineLimitLabel(event);
    if (!label) {
      return [];
    }
    const fallbackRow = event.tl ?? index;
    const x = getLimitDotPercent(session, event.t, fallbackRow);
    return [
      {
        kind: "limit",
        label,
        t: formatMarkerTime(event.t),
        tl: resolveExplicitTraceRow(event.tl, session, event.t, fallbackRow, x),
        x,
      },
    ];
  });
}

function buildSessionEventLimitDots(
  session: AgentSessionDetail
): ActivityMarker[] {
  return session.events.flatMap((event, index) => {
    const label = getSessionEventLimitLabel(event);
    if (!label) {
      return [];
    }
    const x = getLimitDotPercent(session, event.createdAt, index);
    return [
      {
        kind: "limit",
        label,
        t: formatMarkerTime(event.createdAt),
        tl: resolveLimitTraceRow(session, event.createdAt, index, x),
        x,
      },
    ];
  });
}

function buildTurnItemLimitDots(session: AgentSessionDetail): ActivityMarker[] {
  return (session.turnItems ?? []).flatMap((item, index) => {
    const label = getTurnEventLimitLabel(item);
    const timestamp = getTurnItemTimestamp(item);
    if (!(label && timestamp)) {
      return [];
    }
    const fallbackRow = hasTraceRow(item) ? item._row : index;
    const x = getLimitDotPercent(session, timestamp, fallbackRow);
    return [
      {
        kind: "limit",
        label,
        t: formatMarkerTime(timestamp),
        tl: resolveExplicitTraceRow(
          hasTraceRow(item) ? item._row : null,
          session,
          timestamp,
          fallbackRow,
          x
        ),
        x,
      },
    ];
  });
}

function dedupeLimitDotEvents(events: ActivityMarker[]): ActivityMarker[] {
  const seen = new Set<string>();
  const deduped: ActivityMarker[] = [];
  for (const event of events) {
    const key = `${event.tl}:${event.t}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
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
      // FEA-2192: a successful tool turn is routine agent activity, not human
      // steering; only surface a marker when the turn failed. Mirrors the
      // server-side buildTraceMarkers/traceMarkerKind path, which emits no
      // marker for successful tool events.
      return item.hasFail
        ? {
            kind: "fail",
            x,
            t: formatMarkerTime(item.t),
            label: item.summary,
            tl: item._row,
          }
        : null;
    case "event":
      if (getTurnEventLimitLabel(item)) {
        return null;
      }
      return {
        kind: getEventMarkerKind(item.dot),
        x,
        t: formatMarkerTime(item.t),
        label: item.tag ?? item.text,
        tl: item._row,
      };
    case "subagent": {
      // FEA-2192: a completed subagent run is routine agent activity, not human
      // steering; only mark failures (see the "tools" case). Cloud-sourced
      // subagents report "error" (not just "fail") as their failure status, so
      // match the package-wide vocabulary (agent-tree-utils) and the server-side
      // traceMarkerKind, which both treat "error" and "fail" as failures.
      const statusLower = item.status.toLowerCase();
      return statusLower.includes("fail") || statusLower.includes("error")
        ? {
            kind: "fail",
            x,
            t: formatMarkerTime(item.t),
            label: item.sub,
            tl: item._row,
          }
        : null;
    }
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
  limitDotEvents: ActivityMarker[],
  bucketCount: number
): DotCell[] {
  if (bucketCount === 0) {
    return [];
  }
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
  for (const event of limitDotEvents) {
    cells[getBucketIndexFromPercent(event.x, bucketCount)].r.push({
      kind: event.kind,
      label: event.label,
      t: event.t,
      tl: event.tl,
    });
  }
  return cells;
}

function formatThrottleLimitLabel(throttle: SessionThrottle): string {
  const duration = formatThrottleDuration(throttle.durMin);
  if (duration) {
    return `Throttled for ${duration}; resumed ${formatMarkerTime(throttle.t1)}`;
  }
  return `Throttled; resumed ${formatMarkerTime(throttle.t1)}`;
}

function formatThrottleSourceLimitLabel(
  source: SessionTraceThrottleSource
): string {
  const title =
    formatLimitLabelText(source.limitKind) ??
    formatLimitLabelText(source.errorCode) ??
    formatLimitLabelText(source.sourceType) ??
    "Session limit";
  const details = [
    source.provider,
    formatStatusCodeLabel(source.statusCode),
  ].filter(isNonEmptyString);
  if (details.length > 0) {
    return `${title} (${details.join(", ")})`;
  }
  return title;
}

function getTimelineLimitLabel(event: SessionTimelineEvent): string | null {
  const matched = firstLimitText([
    event.title,
    event.detail,
    typeof event.err === "string" ? event.err : null,
  ]);
  if (!matched) {
    return null;
  }
  return preferLimitLabel(event.title ?? event.detail, matched);
}

function getSessionEventLimitLabel(
  event: SyncedAgentSessionEvent
): string | null {
  const matched = firstLimitText([
    event.eventType,
    event.toolName,
    event.summary,
    getLimitDataText(event.data),
  ]);
  if (!matched) {
    return null;
  }
  return preferLimitLabel(event.summary ?? event.eventType, matched);
}

function getTurnEventLimitLabel(item: TurnItem): string | null {
  if (item.type !== "event") {
    return null;
  }
  const matched =
    item.dot === "r" ? firstLimitText([item.tag, item.text]) : null;
  if (!matched) {
    return null;
  }
  return preferLimitLabel(item.tag ?? item.text, matched);
}

function firstLimitText(values: readonly (string | null | undefined)[]) {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed && LIMIT_EVENT_TEXT_REGEX.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

function getLimitDataText(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const values: string[] = [];
  for (const key of LIMIT_DATA_TEXT_KEYS) {
    const field = value[key];
    if (key === "statusCode" && typeof field === "number") {
      values.push(`HTTP ${field}`);
      continue;
    }
    if (typeof field === "string") {
      values.push(field);
      continue;
    }
    if (typeof field === "number") {
      values.push(String(field));
    }
  }
  if (values.length === 0) {
    return null;
  }
  return values.join(" ");
}

function preferLimitLabel(
  preferred: string | null | undefined,
  matched: string
): string {
  const trimmed = preferred?.trim();
  if (trimmed && LIMIT_EVENT_TEXT_REGEX.test(trimmed)) {
    return trimmed;
  }
  return matched;
}

function getTurnItemTimestamp(item: TurnItem): string | null {
  if ("t" in item && typeof item.t === "string") {
    return item.t;
  }
  return null;
}

function resolveExplicitTraceRow(
  explicitRow: number | null | undefined,
  session: AgentSessionDetail,
  timestamp: unknown,
  fallbackRow: number,
  fallbackPercent: number
): number {
  if (typeof explicitRow === "number" && Number.isFinite(explicitRow)) {
    return normalizeTraceRow(explicitRow);
  }
  return resolveLimitTraceRow(session, timestamp, fallbackRow, fallbackPercent);
}

function resolveLimitTraceRow(
  session: AgentSessionDetail,
  timestamp: unknown,
  fallbackRow: number,
  fallbackPercent: number
): number {
  const rows = session.turnItems?.filter(hasTimedTraceRow) ?? [];
  const timestampMs = getDateMs(timestamp);
  if (Number.isFinite(timestampMs) && rows.length > 0) {
    return getNearestTraceRow(rows, timestampMs);
  }
  return getTraceRowFromPercent(session, fallbackPercent, fallbackRow);
}

function getNearestTraceRow(
  rows: (TurnItem & { _row: number; t: string })[],
  timestampMs: number
): number {
  let nearestRow = rows[0]?._row ?? 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const distance = Math.abs(getTurnItemMs(row) - timestampMs);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestRow = row._row;
    }
  }
  return normalizeTraceRow(nearestRow);
}

function getTraceRowFromPercent(
  session: AgentSessionDetail,
  percent: number,
  fallbackRow: number
): number {
  const rows = session.turnItems?.filter(hasTraceRow) ?? [];
  if (rows.length === 0) {
    return normalizeTraceRow(fallbackRow);
  }
  const index = clamp(
    Math.round((clampPercent(percent) / 100) * (rows.length - 1)),
    0,
    rows.length - 1
  );
  return normalizeTraceRow(rows[index]?._row ?? fallbackRow);
}

function getLimitDotPercent(
  session: AgentSessionDetail,
  timestamp: unknown,
  fallbackRow: number
): number {
  const timestampMs = getDateMs(timestamp);
  const startedMs = getDateMs(session.startedAt);
  const endedMs = getDateMs(session.endedAt ?? session.updatedAt);
  if (
    Number.isFinite(timestampMs) &&
    Number.isFinite(startedMs) &&
    Number.isFinite(endedMs) &&
    endedMs > startedMs
  ) {
    return clampPercent(
      ((timestampMs - startedMs) / (endedMs - startedMs)) * 100
    );
  }
  return getTraceRowPercent(session, fallbackRow);
}

function getTraceRowPercent(
  session: AgentSessionDetail,
  fallbackRow: number
): number {
  const rows = session.turnItems?.filter(hasTraceRow) ?? [];
  if (rows.length <= 1) {
    return 0;
  }
  const index = rows.findIndex((row) => row._row >= fallbackRow);
  if (index >= 0) {
    return (index / (rows.length - 1)) * 100;
  }
  return 100;
}

function getDateMs(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value !== "string") {
    return Number.NaN;
  }
  return Date.parse(value);
}

function normalizeTraceRow(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return clamp(value, 0, 100);
}

function formatThrottleDuration(value: number): string | null {
  if (!(Number.isFinite(value) && value > 0)) {
    return null;
  }
  if (value < 1) {
    return "<1m";
  }
  return `${Math.round(value)}m`;
}

function formatLimitLabelText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed
    .split(LIMIT_LABEL_SPLIT_REGEX)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function formatStatusCodeLabel(
  value: number | null | undefined
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return `HTTP ${value}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      <PropertyValue
        copyValue={session.externalSessionId}
        icon={FingerprintIcon}
        label="Session ID"
        mono
      >
        {session.externalSessionId}
      </PropertyValue>
      <PropertyValue icon={FolderGit2Icon} label="Repository" mono>
        {summary.repo}
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
        {session.branch ?? "None"}
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
      <span className="sd3-pp mono" title={summary.model}>
        <BotIcon aria-hidden className="size-3" />
        <span className="min-w-0 truncate">{summary.model}</span>
      </span>
      <span className="sd3-pp mono" title={summary.repo}>
        <FolderGit2Icon aria-hidden className="size-3" />
        <span className="min-w-0 truncate">{summary.repo}</span>
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
const COMMENTS_RAIL_COLLAPSED_KEY = "sessions:comments-rail:collapsed";
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
const LIMIT_EVENT_TEXT_REGEX =
  /(?:session[-_.\s]?limit|usage[-_.\s]?limit|rate[-_.\s]?limit|rate limited|throttl|\b429\b)/i;
const LIMIT_LABEL_SPLIT_REGEX = /[-_.\s]+/;
const LIMIT_DATA_TEXT_KEYS = [
  "type",
  "limitKind",
  "code",
  "error",
  "message",
  "reason",
  "status",
  "statusCode",
] as const;
