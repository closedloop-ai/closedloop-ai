"use client";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  type BranchTraceResult,
  BranchTraceSessionHydrationState,
} from "@repo/api/src/types/branch-trace";
import type { BranchTracePageResult } from "@repo/api/src/types/branch-trace-paging";
import {
  CommentSurface,
  CommentTargetType,
  type TraceTextAnchor,
} from "@repo/api/src/types/comment";
import type { SessionTimelineDetail } from "@repo/api/src/types/document-sessions";
import {
  followTimelineWindowStart,
  resolveTimelineColumnIndex,
  TimelineScale,
  type TimelineScale as TimelineScaleType,
  timelineColumnStartMs,
} from "@repo/app/agents/lib/session-timeline-scale";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY,
  BRANCH_TRACE_PARTIAL_SESSION_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import {
  TRACE_BRANCH_EVENTS_TRUNCATED_NOTE,
  traceBranchUnreadableItemsNote,
} from "@repo/app/shared/lib/trace-truncation-copy";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useBranchTracePages } from "../../hooks/use-branch-trace-pages";
import type { BranchesQueryIdentity } from "../../hooks/use-branches";
import type { BranchActorColorDomain } from "../../lib/branch-actor-domain";
import {
  type BranchTimelineGrouping,
  buildSessionTimeline,
  DEFAULT_BRANCH_TIMELINE_GROUPING,
} from "../../lib/branch-session-buckets";
import { fractionOf, type TimeRange } from "../../lib/branch-timeline-range";
import {
  branchTraceWithoutPartialSessions,
  branchTraceWithPartialSessions,
  unreadableTraceItemCount,
} from "../../lib/branch-trace-partial-sessions";
import {
  BranchTracePlayheadProvider,
  useBranchTracePlayhead,
} from "../../lib/branch-trace-playhead";
import type { PreferredBranchLoc } from "../../lib/preferred-branch-loc";
import { BranchEventDotRail } from "../branch-event-dot-rail";
import {
  BranchMergedTrace,
  type BranchTraceSessionTotal,
} from "../branch-merged-trace";
import { BranchPrActivityTimeline } from "../branch-pr-activity-timeline";
import { detailForLoadedTimelineSessions } from "../branch-pr-activity-timeline-helpers";
import { buildTimelineHumanActorDomain } from "../branch-timeline-human-domain";
import type {
  BranchCommentDraftTarget,
  BranchRenderedSessions,
} from "../comments/branch-comments-model";
import {
  type BranchSessionsPanelStateProps,
  BranchSessionsPanelStateView,
} from "./branch-sessions-panel-states";
import {
  BranchTraceSessionCount,
  BranchTraceSessionLinks,
  branchTraceSessionLabel,
  useBranchTraceSessionLinksDisclosure,
} from "./branch-trace-session-links";

/**
 * ISS-10793: the Branch Sessions tab as a presentational panel -- the
 * existing "Sessions & timeline" view (event dot rail, per-actor swimlanes,
 * PR activity timeline, playhead, combined trace) with its data passed in.
 *
 * It fetches nothing: the host passes the trace query result (the production
 * `BranchSessionsTimelineTab` does exactly that today; moving the fetch into
 * the Branch adapter is ISS-10797). The partial-session and cost-fallback
 * flags are read HERE, where they swap behaviour -- the repo's one-read-site
 * rule (no-threaded-feature-flag) forbids passing a flag in as a prop.
 *
 * Scrolling: `scrollElementRef` is the panel's one scroll container
 * (`.sd3-scroll`). The timeline strip is sticky inside it, and the combined
 * trace and jump-to-row scroll it; hosts must not add a second scroll owner.
 *
 * The three comment hooks (`onRenderedSessionsChange`,
 * `onComposerTargetChange`, `pendingJumpAnchor`) are passed through for the
 * comments rail; the rail's behaviour is ISS-10794's.
 */
export type BranchSessionsTimelinePanelProps = BranchSessionsPanelStateProps & {
  detail: SessionTimelineDetail;
  showBranchContext?: boolean;
  loc?: PreferredBranchLoc;
  onComposerTargetChange?: (target: BranchCommentDraftTarget | null) => void;
  /**
   * A Session's detail href by its artifact id; the route is the host's
   * (ISS-10797). Omitted, the trace heading names no Sessions (ISS-12210).
   */
  getSessionHref?: (sessionId: string) => string;
  onRenderedSessionsChange?: (value: BranchRenderedSessions) => void;
  /** Retry for the `error` state. */
  onRetry?: () => void;
  pendingJumpAnchor?: TraceTextAnchor | null;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  trace: {
    data: BranchTracePageResult | null | undefined;
    isLoading: boolean;
    loadMore?: () => void;
    retryPage?: () => void;
    isRetrying?: boolean;
    hasMore?: boolean;
  };
};

export const TIMELINE_NOT_LOADED_COVERAGE_NOTE =
  "Session comment coverage is unavailable until the timeline loads.";

export function BranchSessionsTimelinePanel({
  detail,
  getSessionHref,
  showBranchContext = true,
  loc,
  onComposerTargetChange,
  onRenderedSessionsChange,
  onRetry,
  stateContent,
  pendingJumpAnchor,
  scrollElementRef,
  state,
  trace,
}: BranchSessionsTimelinePanelProps) {
  const partialSessionsEnabled = useFeatureFlagEnabledOptional(
    BRANCH_TRACE_PARTIAL_SESSION_FEATURE_FLAG_KEY
  );
  // ISS-9723: resolved ABOVE the trace, the timeline strip, the dot rail and the
  // swimlane, so every one of them draws the same population — a partial Session
  // cannot be kept by one and withheld by another.
  const {
    items,
    overviewItems,
    sessions,
    qualifyingSessionCount,
    completeness,
    aggregateCompleteness,
  } = trace.data ?? {};
  const fullItems = overviewItems ?? items;
  const overview = useMemo<BranchTraceResult | null>(() => {
    if (
      !(fullItems && sessions) ||
      qualifyingSessionCount === undefined ||
      !completeness ||
      !aggregateCompleteness
    ) {
      return null;
    }
    return {
      items: fullItems,
      sessions,
      qualifyingSessionCount,
      completeness,
      aggregateCompleteness,
    };
  }, [
    fullItems,
    sessions,
    qualifyingSessionCount,
    completeness,
    aggregateCompleteness,
  ]);
  const traceResult = useMemo(
    () =>
      partialSessionsEnabled
        ? branchTraceWithPartialSessions(overview)
        : branchTraceWithoutPartialSessions(overview),
    [overview, partialSessionsEnabled]
  );
  const loadedItems = useMemo(() => {
    const loaded = partialSessionsEnabled
      ? branchTraceWithPartialSessions(trace.data)
      : branchTraceWithoutPartialSessions(trace.data);
    return loaded?.items ?? [];
  }, [trace.data, partialSessionsEnabled]);
  const detailWithTrace = useMemo<SessionTimelineDetail>(
    () => ({ ...detail, mergedTrace: [...(traceResult?.items ?? [])] }),
    [detail, traceResult]
  );
  const humanDomain = useMemo(
    () => buildTimelineHumanActorDomain(detailWithTrace, traceResult),
    [detailWithTrace, traceResult]
  );
  // A supplied `state` wins over `trace.isLoading` (so `empty` is reachable on
  // a cold query), except that `ready` with no trace yet still waits: drawing
  // the timeline then would show the trace-unavailable alert for a load.
  const hostState =
    state === "ready" && trace.isLoading && trace.data == null
      ? "loading"
      : state;
  const resolvedState = hostState ?? (trace.isLoading ? "loading" : "ready");
  // A loading that follows a rendered timeline is a refetch: keep the
  // timeline mounted (busy) rather than swap in the skeleton, so its playhead,
  // scroll and drafts survive. First paint, or a retry after a non-ready state,
  // still shows the skeleton.
  const [timelineMounted, setTimelineMounted] = useState(
    resolvedState === "ready"
  );
  const refreshing =
    resolvedState === "loading" && timelineMounted && traceResult != null;
  const showsTimeline = resolvedState === "ready" || refreshing;
  if (showsTimeline !== timelineMounted) {
    setTimelineMounted(showsTimeline);
  }
  useEffect(() => {
    const traceState = traceResult;
    // Any host-set state other than `ready` (or a busy refetch, which keeps the
    // timeline on screen) hides the timeline even when cached
    // trace data is still around (a failed refetch, or a refetch still in
    // flight), so the rail must not offer comments against sessions that are
    // not on screen. `loading` is included for that reason: a host that passes
    // it while holding a cached trace would otherwise publish the full session
    // list under the skeleton. `empty` has no sessions to comment on and
    // explains itself, so it carries no note.
    if (state !== undefined && state !== "ready" && !refreshing) {
      onRenderedSessionsChange?.({
        coverageNote:
          state === "empty" ? null : TIMELINE_NOT_LOADED_COVERAGE_NOTE,
        sessionIds: [],
      });
      return;
    }
    if (!traceState) {
      onRenderedSessionsChange?.({
        coverageNote: TIMELINE_NOT_LOADED_COVERAGE_NOTE,
        sessionIds: [],
      });
      return;
    }
    const sessionIds = traceState.sessions
      .filter(
        (session) => session.state === BranchTraceSessionHydrationState.Loaded
      )
      .map((session) => session.identity.artifactId);
    // ISS-9723: this note claims comments are restricted to a SUBSET of the
    // Sessions, so it must key on Sessions actually being withheld — not on
    // `completeness`, which now also goes incomplete when every Session
    // rendered and only some of their ITEMS were dropped. Comment coverage is
    // per Session, so that cause excludes nobody.
    const withheldSessions =
      traceState.qualifyingSessionCount === null ||
      sessionIds.length < traceState.qualifyingSessionCount;
    onRenderedSessionsChange?.({
      coverageNote: withheldSessions
        ? "Comments are shown only for Sessions rendered in this incomplete timeline."
        : null,
      sessionIds,
    });
  }, [onRenderedSessionsChange, refreshing, state, traceResult]);
  if (!showsTimeline) {
    if (resolvedState === "loading") {
      return <Skeleton className="mt-3 h-[420px] w-full" />;
    }
    return (
      <BranchSessionsPanelStateView
        content={
          resolvedState === "empty" ? undefined : stateContent?.[resolvedState]
        }
        onRetry={onRetry}
        state={resolvedState}
      />
    );
  }
  return (
    <BranchTracePlayheadProvider traceItems={detailWithTrace.mergedTrace}>
      <BranchSessionsTimelineBody
        busy={refreshing}
        detail={detailWithTrace}
        getSessionHref={getSessionHref}
        humanDomain={humanDomain}
        isRetryingPage={trace.isRetrying}
        key={detail.id}
        loadedItems={loadedItems}
        loc={loc}
        onComposerTargetChange={onComposerTargetChange}
        onRequestMore={trace.hasMore ? trace.loadMore : undefined}
        onRetryPage={trace.retryPage}
        pendingJumpAnchor={pendingJumpAnchor}
        scrollElementRef={scrollElementRef}
        showBranchContext={showBranchContext}
        traceEventsTruncated={traceResult?.completeness.eventsTruncated}
        traceState={traceResult}
        traceUnreadableItemCount={unreadableTraceItemCount(traceResult)}
      />
    </BranchTracePlayheadProvider>
  );
}

export type BranchSessionsTimelineTabProps = {
  detail: BranchPageDetail;
  loc?: PreferredBranchLoc;
  onComposerTargetChange?: (target: BranchCommentDraftTarget | null) => void;
  onRenderedSessionsChange?: (value: BranchRenderedSessions) => void;
  pendingJumpAnchor?: TraceTextAnchor | null;
  queryIdentity?: BranchesQueryIdentity;
  scrollElementRef: RefObject<HTMLDivElement | null>;
};

/**
 * Lazy trace tab with one shared color domain and playhead controller.
 *
 * ISS-10793: the legacy Branch page's data-owning wrapper (no host `state`, no
 * `getSessionHref`); `BranchShellView` fetches itself and passes `getSessionHref`.
 */
export function BranchSessionsTimelineTab({
  queryIdentity,
  ...props
}: BranchSessionsTimelineTabProps) {
  const traceQuery = useBranchTracePages(
    props.detail.id,
    undefined,
    queryIdentity
  );
  return (
    <BranchSessionsTimelinePanel
      {...props}
      trace={{
        data: traceQuery.data,
        isLoading: traceQuery.isLoading,
        loadMore: traceQuery.loadMore,
        retryPage: traceQuery.isFetchNextPageError
          ? traceQuery.retryPage
          : undefined,
        isRetrying: traceQuery.isFetchingNextPage,
        hasMore: traceQuery.hasNextPage,
      }}
    />
  );
}

function BranchSessionsTimelineBody({
  busy,
  getSessionHref,
  showBranchContext,
  loadedItems,
  onRequestMore,
  onRetryPage,
  isRetryingPage,
  detail,
  humanDomain,
  loc,
  onComposerTargetChange,
  pendingJumpAnchor,
  scrollElementRef,
  traceEventsTruncated,
  traceState,
  traceUnreadableItemCount,
}: {
  busy: boolean;
  getSessionHref?: (sessionId: string) => string;
  showBranchContext: boolean;
  loadedItems: BranchTraceResult["items"];
  onRequestMore?: () => void;
  onRetryPage?: () => void;
  isRetryingPage?: boolean;
  detail: SessionTimelineDetail;
  humanDomain: BranchActorColorDomain;
  loc?: PreferredBranchLoc;
  onComposerTargetChange?: (target: BranchCommentDraftTarget | null) => void;
  pendingJumpAnchor?: TraceTextAnchor | null;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  traceEventsTruncated?: true;
  traceState: BranchTraceResult | null | undefined;
  traceUnreadableItemCount: number;
}) {
  const fallbackCostMarkerEnabled = useFeatureFlagEnabledOptional(
    BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY
  );
  const controller = useBranchTracePlayhead();
  const [isTraceEndActive, setIsTraceEndActive] = useState(false);
  const [timelineGrouping, setTimelineGrouping] =
    useState<BranchTimelineGrouping>(DEFAULT_BRANCH_TIMELINE_GROUPING);
  const [timelineScale, setTimelineScale] = useState<TimelineScaleType>(
    TimelineScale.OneHour
  );
  const [timelineWindowStart, setTimelineWindowStart] = useState(0);
  const handleScrubToTimestamp = useCallback(
    (timestamp: string) => {
      setIsTraceEndActive(false);
      controller.scrubToTimestamp(timestamp);
    },
    [controller]
  );
  const handleScrubToRow = useCallback(
    (row: number, flash?: boolean) => {
      setIsTraceEndActive(false);
      controller.scrubToRow(row, flash);
    },
    [controller]
  );
  const handleScrolledToTraceEnd = useCallback(() => {
    if (onRequestMore) {
      onRequestMore();
    } else {
      setIsTraceEndActive(true);
    }
  }, [onRequestMore]);
  const handleTraceSelectionChange = useCallback(
    (anchor: TraceTextAnchor | null) => {
      if (!anchor) {
        return;
      }
      const sessionId = anchor.sessionId;
      const isRenderedSession = Boolean(
        sessionId &&
          traceState?.sessions.some(
            (session) =>
              session.state === BranchTraceSessionHydrationState.Loaded &&
              session.identity.artifactId === sessionId
          )
      );
      onComposerTargetChange?.({
        anchor: {
          id: `${anchor.traceId}:${anchor.turnId}:${anchor.row}:${anchor.startOffset}:${anchor.endOffset}`,
          label: anchor.selectedText,
          trace: anchor,
        },
        target:
          isRenderedSession && sessionId
            ? { type: CommentTargetType.Session, id: sessionId }
            : { type: CommentTargetType.Branch, id: detail.id },
        ...(isRenderedSession
          ? {}
          : {
              collectionQuery: {
                surface: CommentSurface.BranchTimeline,
              },
            }),
      });
    },
    [detail.id, onComposerTargetChange, traceState]
  );
  useEffect(() => {
    if (pendingJumpAnchor) {
      handleScrubToRow(pendingJumpAnchor.row, true);
    }
  }, [handleScrubToRow, pendingJumpAnchor]);
  const renderedDetail = useMemo(
    () =>
      detailForLoadedTimelineSessions(detail, traceState, {
        requireKnownLoadedCost: fallbackCostMarkerEnabled,
      }),
    [detail, fallbackCostMarkerEnabled, traceState]
  );
  const timeline = useMemo(
    () =>
      buildSessionTimeline(renderedDetail, humanDomain, timelineGrouping, {
        scale: timelineScale,
        windowStart: timelineWindowStart,
      }),
    [
      renderedDetail,
      humanDomain,
      timelineGrouping,
      timelineScale,
      timelineWindowStart,
    ]
  );
  useEffect(() => {
    setTimelineWindowStart((current) =>
      Math.max(0, Math.min(current, timeline.maxWindowStart))
    );
  }, [timeline.maxWindowStart]);
  const handleTimelineScaleChange = useCallback(
    (nextScale: TimelineScaleType) => {
      setTimelineScale(nextScale);
      setTimelineWindowStart(0);
    },
    []
  );
  const activeHourStarts = useMemo(
    () =>
      timeline.columns
        .filter((column) => !column.isGap)
        .map((column) => column.hourStart),
    [timeline]
  );
  const sessionTotals = useMemo(() => deriveSessionTotals(detail), [detail]);
  const range = useMemo<TimeRange | null>(() => {
    const { startMs, endMs } = timeline;
    return startMs != null && endMs != null
      ? { startMs, endMs, spanMs: Math.max(1, endMs - startMs) }
      : null;
  }, [timeline]);
  const sessionCount = timeline.distinctSessionCount;
  const sourceSessionCount = new Set(
    detail.sessions.map(({ sessionId }) => sessionId)
  ).size;
  const totalSessionCount = showBranchContext
    ? sourceSessionCount
    : (traceState?.qualifyingSessionCount ?? sourceSessionCount);
  const sessionLabel =
    sessionCount === totalSessionCount
      ? `${sessionCount} session${sessionCount === 1 ? "" : "s"}`
      : `${sessionCount} of ${totalSessionCount} sessions rendered`;
  const showSessionCount =
    showBranchContext || traceState?.qualifyingSessionCount !== null;
  const sessionLinks = useBranchTraceSessionLinksDisclosure({
    branchId: detail.id,
    hasLinks: Boolean(getSessionHref && traceState),
    sessionCount: renderedDetail.sessions.length,
    showSessionCount,
  });
  const activeFraction = useMemo(() => {
    if (isTraceEndActive) {
      return 1;
    }
    if (!(range && controller.activeTimestamp)) {
      return null;
    }
    const timestamp = Date.parse(controller.activeTimestamp);
    return Number.isNaN(timestamp) ? null : fractionOf(range, timestamp);
  }, [isTraceEndActive, range, controller.activeTimestamp]);
  const activeTimelineColumn = useMemo(() => {
    if (isTraceEndActive) {
      return Math.max(0, timeline.totalColumns - 1);
    }
    return resolveActiveTimelineColumn({
      originMs: timeline.fullStartMs,
      scale: timelineScale,
      timestamp: controller.activeTimestamp,
      totalColumns: timeline.totalColumns,
    });
  }, [
    controller.activeTimestamp,
    isTraceEndActive,
    timeline.fullStartMs,
    timeline.totalColumns,
    timelineScale,
  ]);
  useEffect(() => {
    if (activeTimelineColumn == null) {
      return;
    }
    setTimelineWindowStart((current) =>
      followTimelineWindowStart({
        activeColumn: activeTimelineColumn,
        currentWindowStart: current,
        maxWindowStart: timeline.maxWindowStart,
      })
    );
  }, [activeTimelineColumn, timeline.maxWindowStart]);
  const handleTimelinePositionChange = useCallback(
    (column: number) => {
      const timestamp = timestampForTimelineColumn({
        column,
        originMs: timeline.fullStartMs,
        scale: timelineScale,
        totalColumns: timeline.totalColumns,
      });
      if (timestamp) {
        handleScrubToTimestamp(timestamp);
      }
      setTimelineWindowStart((current) =>
        followTimelineWindowStart({
          activeColumn: column,
          currentWindowStart: current,
          maxWindowStart: timeline.maxWindowStart,
        })
      );
    },
    [
      handleScrubToTimestamp,
      timeline.fullStartMs,
      timeline.maxWindowStart,
      timeline.totalColumns,
      timelineScale,
    ]
  );
  const activeHourStart = isTraceEndActive
    ? (timeline.columns.at(-1)?.hourStart ?? null)
    : resolveActiveTimelineColumnStart({
        fallback: controller.activeHourStart,
        originMs: timeline.fullStartMs,
        scale: timelineScale,
        timestamp: controller.activeTimestamp,
        totalColumns: timeline.totalColumns,
      });

  return (
    <div aria-busy={busy || undefined} className="bq-sessions-workspace sd3">
      <div className="sd3-main">
        <div className="bq-page-scroll sd3-scroll" ref={scrollElementRef}>
          <div className="bq-sessions-main">
            <div className="flex flex-col gap-6">
              <div className="bq-timeline-sticky">
                <BranchPrActivityTimeline
                  activeFraction={activeFraction}
                  activeHourStart={activeHourStart}
                  actorDomain={humanDomain}
                  detail={detail}
                  grouping={timelineGrouping}
                  loc={loc}
                  onGroupingChange={setTimelineGrouping}
                  onPositionChange={handleTimelinePositionChange}
                  onScaleChange={handleTimelineScaleChange}
                  onScrubHour={handleScrubToTimestamp}
                  onWindowStartChange={setTimelineWindowStart}
                  positionColumn={activeTimelineColumn}
                  scale={timelineScale}
                  showBranchContext={showBranchContext}
                  traceState={traceState}
                  windowStart={timelineWindowStart}
                >
                  <BranchEventDotRail
                    activeColumnGrid={
                      timeline.fullStartMs == null
                        ? undefined
                        : {
                            originMs: timeline.fullStartMs,
                            scale: timelineScale,
                          }
                    }
                    activeHourStarts={activeHourStarts}
                    activeRow={controller.activeRow}
                    alignToTimelineColumns
                    commits={detail.commits ?? []}
                    mergedAt={detail.mergedAt}
                    onScrub={handleScrubToTimestamp}
                    onScrubRow={handleScrubToRow}
                    openedAt={detail.openedAt}
                    prNumber={detail.prNumber}
                    pullRequests={detail.associatedPullRequests?.items}
                    range={range}
                    traceItems={detail.mergedTrace}
                  />
                </BranchPrActivityTimeline>
              </div>

              <div className="bq-act">
                <div className="bq-act-head">
                  <span className="bq-act-title">
                    Combined session trace
                    {showSessionCount ? (
                      <span className="bq-act-sub">
                        {" "}
                        ·{" "}
                        <BranchTraceSessionCount
                          disclosure={sessionLinks}
                          label={sessionLabel}
                        />
                      </span>
                    ) : null}
                    {traceEventsTruncated ? (
                      <span className="bq-act-sub">
                        {" "}
                        · {TRACE_BRANCH_EVENTS_TRUNCATED_NOTE}
                      </span>
                    ) : null}
                    {traceUnreadableItemCount > 0 ? (
                      <span className="bq-act-sub">
                        {" "}
                        ·{" "}
                        {traceBranchUnreadableItemsNote(
                          traceUnreadableItemCount
                        )}
                      </span>
                    ) : null}
                  </span>
                  {sessionLinks.available && getSessionHref ? (
                    <BranchTraceSessionLinks
                      getSessionHref={getSessionHref}
                      hidden={!sessionLinks.visible}
                      id={sessionLinks.id}
                      sessions={renderedDetail.sessions}
                    />
                  ) : null}
                </div>
                <BranchMergedTrace
                  activeRow={controller.activeRow}
                  actorDomain={humanDomain}
                  highlightAnchor={pendingJumpAnchor}
                  isRetryingPage={isRetryingPage}
                  onJump={handleScrubToRow}
                  onRequestMore={onRequestMore}
                  onRetryPage={onRetryPage}
                  onScrolledToRow={handleScrubToRow}
                  onScrolledToTraceEnd={handleScrolledToTraceEnd}
                  onTraceSelectionChange={handleTraceSelectionChange}
                  registerScroll={controller.registerTraceScroll}
                  scrollElementRef={scrollElementRef}
                  sessionTotals={sessionTotals}
                  showBranchContext={showBranchContext}
                  traceItems={loadedItems}
                  traceOverview={detail.mergedTrace}
                  traceState={traceState}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * ISS-8771 — the three column questions this tab asks, all answered by the
 * canonical `session-timeline-scale` grid.
 *
 * Each was previously a local re-derivation over `columnMs` (`Math.floor(ms /
 * columnMs)`, `fullStartMs + n x columnMs`), which is a second contract for the
 * same concept and cannot agree with the bars once a column is not `columnMs`
 * of real time — which a `12h` column holding a DST transition is not. The
 * highlight and the bar it highlights now come from ONE grid, so they cannot
 * point at different instants.
 */
function resolveActiveTimelineColumnStart({
  fallback,
  originMs,
  scale,
  timestamp,
  totalColumns,
}: {
  fallback: string | null;
  originMs: number | null;
  scale: TimelineScaleType;
  timestamp: string | null;
  totalColumns: number;
}): string | null {
  const column = resolveActiveTimelineColumn({
    originMs,
    scale,
    timestamp,
    totalColumns,
  });
  if (column == null || originMs == null) {
    return fallback;
  }
  return new Date(
    timelineColumnStartMs({ columnIndex: column, originMs, scale })
  ).toISOString();
}

/**
 * The column an instant falls in, CLAMPED to the columns that were actually
 * built.
 *
 * The clamp is shared with {@link resolveActiveTimelineColumnStart} rather than
 * applied at one of the two, because the highlight is matched by comparing this
 * function's `hourStart` against a rendered column's. An unclamped start would
 * name a column beyond the 90-day render cap — one `allColumns` never contains —
 * so the bar highlight would silently vanish while the scrubber cursor kept
 * moving, which is the disagreement this migration exists to make impossible.
 */
function resolveActiveTimelineColumn({
  originMs,
  scale,
  timestamp,
  totalColumns,
}: {
  originMs: number | null;
  scale: TimelineScaleType;
  timestamp: string | null;
  totalColumns: number;
}): number | null {
  if (!(timestamp && originMs != null && totalColumns > 0)) {
    return null;
  }
  const instantMs = Date.parse(timestamp);
  if (Number.isNaN(instantMs)) {
    return null;
  }
  return Math.max(
    0,
    Math.min(
      totalColumns - 1,
      resolveTimelineColumnIndex({ instantMs, originMs, scale })
    )
  );
}

function timestampForTimelineColumn({
  column,
  originMs,
  scale,
  totalColumns,
}: {
  column: number;
  originMs: number | null;
  scale: TimelineScaleType;
  totalColumns: number;
}): string | null {
  if (!(originMs != null && totalColumns > 0)) {
    return null;
  }
  const clampedColumn = Math.max(
    0,
    Math.min(totalColumns - 1, Math.round(column))
  );
  const startMs = timelineColumnStartMs({
    columnIndex: clampedColumn,
    originMs,
    scale,
  });
  const endMs = timelineColumnStartMs({
    columnIndex: clampedColumn + 1,
    originMs,
    scale,
  });
  return new Date(startMs + (endMs - startMs) / 2).toISOString();
}

function deriveSessionTotals(
  detail: SessionTimelineDetail
): BranchTraceSessionTotal[] {
  const totals: BranchTraceSessionTotal[] = [];
  const observed = new Set<string>();
  for (const session of detail.sessions) {
    if (
      observed.has(session.sessionId) ||
      session.estimatedCostUsd === null ||
      !Number.isFinite(session.estimatedCostUsd) ||
      session.estimatedCostUsd < 0
    ) {
      continue;
    }
    observed.add(session.sessionId);
    totals.push({
      sessionId: session.sessionId,
      label: branchTraceSessionLabel(session),
      totalCostUsd: session.estimatedCostUsd,
    });
  }
  return totals;
}
