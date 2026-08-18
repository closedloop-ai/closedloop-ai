"use client";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
} from "@repo/api/src/types/branch-trace";
import {
  TraceCommentSurface,
  TraceCommentTargetType,
  type TraceTextAnchor,
} from "@repo/api/src/types/comment";
import { TRACE_BRANCH_EVENTS_TRUNCATED_NOTE } from "@repo/app/shared/lib/trace-truncation-copy";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { BranchesQueryIdentity } from "../../hooks/use-branches";
import { useBranchTrace } from "../../hooks/use-branches";
import type { BranchActorColorDomain } from "../../lib/branch-actor-domain";
import { buildSessionTimeline } from "../../lib/branch-session-buckets";
import { fractionOf, type TimeRange } from "../../lib/branch-timeline-range";
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
import type { BranchCommentDraftTarget } from "../comments/branch-comments-model";

export type BranchSessionsTimelineTabProps = {
  detail: BranchPageDetail;
  loc?: PreferredBranchLoc;
  onComposerTargetChange?: (target: BranchCommentDraftTarget | null) => void;
  onRenderedSessionsChange?: (value: {
    coverageNote: string | null;
    sessionIds: readonly string[];
  }) => void;
  pendingJumpAnchor?: TraceTextAnchor | null;
  queryIdentity?: BranchesQueryIdentity;
  scrollElementRef: RefObject<HTMLDivElement | null>;
};

/** Lazy trace tab with one shared color domain and playhead controller. */
export function BranchSessionsTimelineTab({
  detail,
  loc,
  onComposerTargetChange,
  onRenderedSessionsChange,
  pendingJumpAnchor,
  queryIdentity,
  scrollElementRef,
}: BranchSessionsTimelineTabProps) {
  const traceQuery = useBranchTrace(detail.id, undefined, queryIdentity);
  const detailWithTrace = useMemo<BranchPageDetail>(
    () => ({ ...detail, mergedTrace: [...(traceQuery.data?.items ?? [])] }),
    [detail, traceQuery.data]
  );
  const humanDomain = useMemo(
    () => buildTimelineHumanActorDomain(detailWithTrace, traceQuery.data),
    [detailWithTrace, traceQuery.data]
  );
  useEffect(() => {
    const traceState = traceQuery.data;
    if (!traceState) {
      onRenderedSessionsChange?.({
        coverageNote:
          "Session comment coverage is unavailable until the timeline loads.",
        sessionIds: [],
      });
      return;
    }
    const sessionIds = traceState.sessions
      .filter(
        (session) => session.state === BranchTraceSessionHydrationState.Loaded
      )
      .map((session) => session.identity.artifactId);
    const incomplete =
      traceState.completeness.state !== BranchTraceCompletenessState.Complete;
    onRenderedSessionsChange?.({
      coverageNote: incomplete
        ? "Comments are shown only for Sessions rendered in this incomplete timeline."
        : null,
      sessionIds,
    });
  }, [onRenderedSessionsChange, traceQuery.data]);
  if (traceQuery.isLoading) {
    return <Skeleton className="mt-3 h-[420px] w-full" />;
  }
  return (
    <BranchTracePlayheadProvider traceItems={detailWithTrace.mergedTrace}>
      <BranchSessionsTimelineBody
        detail={detailWithTrace}
        humanDomain={humanDomain}
        key={detail.id}
        loc={loc}
        onComposerTargetChange={onComposerTargetChange}
        pendingJumpAnchor={pendingJumpAnchor}
        scrollElementRef={scrollElementRef}
        traceEventsTruncated={traceQuery.data?.completeness.eventsTruncated}
        traceState={traceQuery.data ?? null}
      />
    </BranchTracePlayheadProvider>
  );
}

function BranchSessionsTimelineBody({
  detail,
  humanDomain,
  loc,
  onComposerTargetChange,
  pendingJumpAnchor,
  scrollElementRef,
  traceEventsTruncated,
  traceState,
}: {
  detail: BranchPageDetail;
  humanDomain: BranchActorColorDomain;
  loc?: PreferredBranchLoc;
  onComposerTargetChange?: (target: BranchCommentDraftTarget | null) => void;
  pendingJumpAnchor?: TraceTextAnchor | null;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  traceEventsTruncated?: true;
  traceState: ReturnType<typeof useBranchTrace>["data"] | null;
}) {
  const controller = useBranchTracePlayhead();
  const [isTraceEndActive, setIsTraceEndActive] = useState(false);
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
    setIsTraceEndActive(true);
  }, []);
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
            ? { type: TraceCommentTargetType.Session, id: sessionId }
            : { type: TraceCommentTargetType.Branch, id: detail.id },
        ...(isRenderedSession
          ? {}
          : {
              collectionQuery: {
                surface: TraceCommentSurface.BranchTimeline,
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
    () => detailForLoadedTimelineSessions(detail, traceState),
    [detail, traceState]
  );
  const timeline = useMemo(
    () => buildSessionTimeline(renderedDetail, humanDomain),
    [renderedDetail, humanDomain]
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
  const totalSessionCount = new Set(
    detail.sessions.map(({ sessionId }) => sessionId)
  ).size;
  const sessionLabel =
    sessionCount === totalSessionCount
      ? `${sessionCount} session${sessionCount === 1 ? "" : "s"}`
      : `${sessionCount} of ${totalSessionCount} sessions rendered`;
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
  const activeHourStart = isTraceEndActive
    ? (timeline.columns.at(-1)?.hourStart ?? null)
    : controller.activeHourStart;

  return (
    <div className="bq-sessions-workspace sd3">
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
                  loc={loc}
                  onScrubHour={handleScrubToTimestamp}
                  traceState={traceState}
                >
                  <BranchEventDotRail
                    activeHourStarts={activeHourStarts}
                    activeRow={controller.activeRow}
                    commits={detail.commits}
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
                    <span className="bq-act-sub"> · {sessionLabel}</span>
                    {traceEventsTruncated ? (
                      <span className="bq-act-sub">
                        {" "}
                        · {TRACE_BRANCH_EVENTS_TRUNCATED_NOTE}
                      </span>
                    ) : null}
                  </span>
                </div>
                <BranchMergedTrace
                  activeRow={controller.activeRow}
                  actorDomain={humanDomain}
                  highlightAnchor={pendingJumpAnchor}
                  onJump={handleScrubToRow}
                  onScrolledToRow={handleScrubToRow}
                  onScrolledToTraceEnd={handleScrolledToTraceEnd}
                  onTraceSelectionChange={handleTraceSelectionChange}
                  registerScroll={controller.registerTraceScroll}
                  scrollElementRef={scrollElementRef}
                  sessionTotals={sessionTotals}
                  traceItems={detail.mergedTrace}
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

function deriveSessionTotals(
  detail: BranchPageDetail
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
      label: session.name ?? session.slug ?? session.sessionId,
      totalCostUsd: session.estimatedCostUsd,
    });
  }
  return totals;
}
