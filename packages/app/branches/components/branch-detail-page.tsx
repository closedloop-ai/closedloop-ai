"use client";

import type {
  BranchAnalytics,
  BranchDataState,
  BranchPageDetail,
} from "@repo/api/src/types/branch";
import { BranchDataState as BranchDataStateValue } from "@repo/api/src/types/branch";
import { TraceCommentsRail } from "@repo/app/agents/components/detail/trace-comments-rail";
import { useTraceComments } from "@repo/app/agents/components/detail/use-trace-comments";
import { ApiError } from "@repo/app/shared/api/api-error";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { Link } from "@repo/navigation/link";
import { AlertCircleIcon, ArrowLeftIcon, GitBranchIcon } from "lucide-react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { BranchesQueryIdentity } from "../hooks/use-branches";
import { useBranchComments, useBranchTrace } from "../hooks/use-branches";
import {
  type BranchActorColorDomain,
  buildActorColorDomain,
  deriveActorsFromSessions,
} from "../lib/branch-actor-domain";
import { buildSessionTimeline } from "../lib/branch-session-buckets";
import { fractionOf, type TimeRange } from "../lib/branch-timeline-range";
import {
  BranchTracePlayheadProvider,
  useBranchTracePlayhead,
} from "../lib/branch-trace-playhead";
import { BranchesOverlayRefreshProvider } from "../lib/live-overlays/overlay-refresh-provider";
import {
  type PreferredBranchLoc,
  usePreferredBranchLoc,
} from "../lib/live-overlays/use-preferred-branch-loc";
import { BranchCostToMerge } from "./branch-cost-to-merge";
import { BranchEventDotRail } from "./branch-event-dot-rail";
import { BranchHeadlineCards } from "./branch-headline-cards";
import { BranchLeadTimeWaterfall } from "./branch-lead-time-waterfall";
import { BranchMergedTrace } from "./branch-merged-trace";
import { BranchMultiPrNotice } from "./branch-multi-pr-notice";
import { BranchPrActivityTimeline } from "./branch-pr-activity-timeline";
import { BranchPrSessionSwimlane } from "./branch-pr-session-swimlane";
import { BranchPropertiesPanel } from "./branch-properties-panel";
import {
  BranchRefreshState,
  BranchRefreshStatus,
} from "./branch-refresh-status";
import { BranchDeliveredPanel } from "./detail/branch-delivered-panel";
import { BranchFilesChangedPanel } from "./detail/branch-files-changed-panel";
import { BranchPrStatusPanel } from "./detail/branch-pr-status-panel";
import { PrCommentsPanel } from "./pr-comments-panel";

/**
 * Surface-shared Branch Detail page body (FEA-1949 / Epic C — C3). Mirrors the
 * verified `AgentSessionDetailView` contract: it is purely presentational,
 * takes the already-fetched shaped data plus `isLoading`/`isError`/`backHref`,
 * and owns only view-local state (the active tab). The desktop wrapper
 * (`branch-detail-view.tsx`) owns the data-source ancestry and the read hooks
 * and forwards their state here, so this body stays portable across surfaces
 * (it lives in `@repo/app/branches/components` per the domain-component rule).
 *
 * Epic D (Branch-details panels) and Epic E (Sessions & timeline — the activity
 * timeline, playhead, event-dot rail, actor swimlane, and the merged-trace
 * reader, all bound to one shared playhead controller) are mounted. Epic F
 * (FEA-1952) mounts the live overlays: the "What was delivered" section (linked
 * PR artifacts + read-only PR description), the live files-changed panel, and
 * the app-focus/manual refresh control.
 *
 * Every branch type is imported path-qualified from `@repo/api/src/types/branch`
 * to avoid the unrelated `BranchDetail` class-table type in `artifact.ts`; the
 * surface detail type is `BranchPageDetail`.
 */

export type BranchDetailPageProps = {
  /** Identity of the branch shown; retained for callers though only `detail` is rendered today. */
  branchId: string;
  detail?: BranchPageDetail;
  analytics?: BranchAnalytics;
  isLoading: boolean;
  isError: boolean;
  errorKind?: BranchDetailErrorKind;
  refreshState?: BranchDetailRefreshState;
  queryIdentity?: BranchesQueryIdentity;
  allowLiveOverlays?: boolean;
  connectHref?: string;
  onConnectGitHub?: () => void;
  backHref: string;
};

export const BranchDetailErrorKind = {
  NotPresent: "not-present",
  ProviderError: "provider-error",
} as const;
export type BranchDetailErrorKind =
  (typeof BranchDetailErrorKind)[keyof typeof BranchDetailErrorKind];

export const BranchDetailRefreshState = BranchRefreshState;
export type BranchDetailRefreshState = BranchRefreshState;

type BranchDetailTab = "branch-details" | "sessions-timeline";

const TAB_BRANCH_DETAILS: BranchDetailTab = "branch-details";
const TAB_SESSIONS_TIMELINE: BranchDetailTab = "sessions-timeline";

export function BranchDetailPage({
  branchId,
  detail,
  analytics,
  isLoading,
  isError,
  errorKind,
  refreshState = BranchDetailRefreshState.Idle,
  queryIdentity,
  allowLiveOverlays = true,
  connectHref,
  onConnectGitHub,
  backHref,
}: BranchDetailPageProps) {
  const [activeTab, setActiveTab] =
    useState<BranchDetailTab>(TAB_BRANCH_DETAILS);
  // The Sessions & timeline tab owns this scroller inside its `.sd3-main`, so
  // the comments rail can sit beside it as a page-level sibling.
  const sessionsScrollRef = useRef<HTMLDivElement>(null);

  // Resolve changed-LOC once, preferring the connected PR's live totals over
  // enrichment (FEA-1952). Shared with the files panel's overlay query key, so
  // React Query dedupes to one fetch; passed to every detail-page LOC consumer.
  // Called before the early returns (Rules of Hooks); tolerates undefined detail.
  const preferredLoc = usePreferredBranchLoc(detail, {
    enableLive: allowLiveOverlays,
  });
  const commentsQuery = useBranchComments(branchId, undefined, queryIdentity);

  // Loading takes priority while the first detail read is still pending, so the
  // two-column layout is stable before the hooks resolve.
  if (isLoading && !detail) {
    return <BranchDetailLoading />;
  }

  if (isError && !detail) {
    return errorKind === BranchDetailErrorKind.NotPresent ? (
      <BranchDetailNotFound backHref={backHref} />
    ) : (
      <BranchDetailProviderError backHref={backHref} />
    );
  }

  if (!detail) {
    return <BranchDetailNotFound backHref={backHref} />;
  }

  const detailState = resolveBranchDetailState(detail);
  const hasSessions = detailState === BranchDetailState.Ready;
  const emptyDetailState = renderBranchEmptyDetailState(detailState);

  const content = (
    <div className="flex min-h-0 flex-1">
      <Tabs
        // No flex gap: the sticky toggle row's own padding is the only
        // space before the content beneath it.
        className="flex min-h-0 w-full flex-1 flex-col gap-0"
        onValueChange={(value) => setActiveTab(value as BranchDetailTab)}
        value={activeTab}
      >
        {/* The page subject as a visually-hidden heading: the visible branch
              name/metadata lives in the Properties panel (no duplicate chrome),
              but the page still owns an in-body <h1> for heading-order/landmark
              navigation per the project's page-title convention. */}
        <h1 className="sr-only">Branch {detail.branchName}</h1>
        {hasSessions ? (
          <>
            <div className="bq-tabs-sticky">
              <TabsList>
                <TabsTrigger value={TAB_BRANCH_DETAILS}>
                  Branch details
                </TabsTrigger>
                <TabsTrigger value={TAB_SESSIONS_TIMELINE}>
                  Sessions &amp; timeline
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent
              className="bq-page-scroll mx-auto min-h-0 w-full max-w-[1000px] flex-1 overflow-auto px-5 pb-4"
              value={TAB_BRANCH_DETAILS}
            >
              {/* Properties belong to the Branch details tab only (collapsed
                      by default) — matches the Branches Page design handoff. */}
              <BranchPropertiesPanel detail={detail} loc={preferredLoc} />
              <BranchDetailRefreshStatus state={refreshState} />
              {detail.multiPrWarning ? (
                <BranchMultiPrNotice linkedPrNumbers={detail.linkedPrNumbers} />
              ) : null}
              <BranchHeadlineCards
                analytics={analytics}
                detail={detail}
                loc={preferredLoc}
              />
              <BranchCostToMerge
                detail={detail}
                suppressSplits={detail.multiPrWarning}
              />
              <BranchLeadTimeWaterfall detail={detail} />
              {/* "What was delivered" — linked PR artifacts + read-only PR
                      description (F-FEA-1952). Files-changed is LIVE from the
                      GitHub gateway (never persisted), degrading per state. */}
              <BranchDeliveredPanel detail={detail} />
              <BranchPrStatusPanel
                allowLive={allowLiveOverlays}
                connectHref={connectHref}
                detail={detail}
                onConnect={onConnectGitHub}
              />
              {allowLiveOverlays ? (
                <BranchFilesChangedPanel branchId={branchId} detail={detail} />
              ) : (
                <BranchOverlayUnavailableState />
              )}
              <PrCommentsPanel
                comments={commentsQuery.data}
                isError={commentsQuery.isError}
                isLoading={commentsQuery.isLoading}
              />
            </TabsContent>
            {/* Radix mounts this panel only while the tab is active, so the
                    events-heavy trace stays lazy and never leaks into the Branch
                    details tab. The trace query cache keeps re-open fast. */}
            <TabsContent
              className="flex min-h-0 flex-1 overflow-hidden"
              value={TAB_SESSIONS_TIMELINE}
            >
              <BranchSessionsTimelineTab
                detail={detail}
                loc={preferredLoc}
                queryIdentity={queryIdentity}
                scrollElementRef={sessionsScrollRef}
              />
            </TabsContent>
          </>
        ) : (
          emptyDetailState
        )}
      </Tabs>
    </div>
  );

  if (!allowLiveOverlays) {
    return content;
  }

  return (
    <BranchesOverlayRefreshProvider>{content}</BranchesOverlayRefreshProvider>
  );
}

export function classifyBranchDetailError(
  error: unknown
): BranchDetailErrorKind {
  if (error instanceof ApiError && error.isNotFound()) {
    return BranchDetailErrorKind.NotPresent;
  }
  return BranchDetailErrorKind.ProviderError;
}

function BranchDetailLoading() {
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        <Skeleton className="h-[520px] w-full" />
      </div>
    </div>
  );
}

function BranchDetailNotFound({ backHref }: { backHref: string }) {
  return (
    <div className="flex min-h-0 flex-1 overflow-auto p-4 sm:p-6">
      <div className="w-full">
        <EmptyState
          className="py-16"
          description="The branch may not exist, or it has no captured sessions yet."
          icon={AlertCircleIcon}
          title="Branch not found"
        />
        <div className="mt-4 flex justify-center">
          <Link className="sd3-back" href={backHref}>
            <ArrowLeftIcon aria-hidden className="size-3.5" />
            Back to Branches
          </Link>
        </div>
      </div>
    </div>
  );
}

function BranchDetailProviderError({ backHref }: { backHref: string }) {
  return (
    <div className="flex min-h-0 flex-1 overflow-auto p-4 sm:p-6">
      <div className="w-full">
        <EmptyState
          className="py-16"
          description="The branch provider could not be reached. Retry refresh, or check the provider connection."
          icon={AlertCircleIcon}
          title="Branch provider unavailable"
        />
        <div className="mt-4 flex justify-center">
          <Link className="sd3-back" href={backHref}>
            <ArrowLeftIcon aria-hidden className="size-3.5" />
            Back to Branches
          </Link>
        </div>
      </div>
    </div>
  );
}

function BranchDetailRefreshStatus({
  state,
}: {
  state: BranchDetailRefreshState;
}) {
  return (
    <BranchRefreshStatus
      className="mb-3"
      state={state}
      subject="branch detail"
    />
  );
}

function BranchOverlayUnavailableState() {
  return (
    <div className="mt-4 rounded-md border border-[var(--border)] bg-[var(--muted)]/30 p-4">
      <p className="font-medium text-sm">Live file overlays unavailable</p>
      <p className="mt-1 text-[var(--muted-foreground)] text-xs">
        Cloud-synced branch data remains visible. File diffs are unavailable on
        this surface.
      </p>
    </div>
  );
}

function BranchNoSessionsState() {
  return (
    <EmptyState
      description="Sessions appear here once an agent works this branch. There's nothing to show yet."
      icon={GitBranchIcon}
      title="No sessions on this branch yet"
    />
  );
}

function renderBranchEmptyDetailState(state: BranchDetailState): ReactNode {
  if (state === BranchDetailState.AwaitingSync) {
    return (
      <div className="bq-page-scroll min-h-0 flex-1 overflow-auto px-5 py-4">
        <BranchAwaitingSyncState />
      </div>
    );
  }
  if (state === BranchDetailState.NotPresent) {
    return (
      <div className="bq-page-scroll min-h-0 flex-1 overflow-auto px-5 py-4">
        <BranchNotPresentState />
      </div>
    );
  }
  return (
    <div className="bq-page-scroll min-h-0 flex-1 overflow-auto px-5 py-4">
      <BranchNoSessionsState />
    </div>
  );
}

function BranchAwaitingSyncState() {
  return (
    <EmptyState
      description="Branch data is being synchronized. Refresh this page after sync completes."
      icon={GitBranchIcon}
      title="Branch sync in progress"
    />
  );
}

function BranchNotPresentState() {
  return (
    <EmptyState
      description="The provider no longer reports this branch. It may have been deleted, renamed, or become unavailable."
      icon={AlertCircleIcon}
      title="Branch no longer present"
    />
  );
}

/**
 * Sessions & timeline tab (Epic E). Builds ONE shared actor-color domain (from
 * the sessions — usage owners are null in v1) and ONE shared playhead controller
 * (over the merged trace) that the timeline (E1), playhead (E2), event-dot rail
 * (E3), swimlane (E4), and merged trace (D2) all bind to — none import each
 * other, breaking the timeline↔trace cycle. Order matches the design: timeline →
 * combined session trace → swimlane.
 */
function BranchSessionsTimelineTab({
  detail,
  loc,
  queryIdentity,
  scrollElementRef,
}: {
  detail: BranchPageDetail;
  loc?: PreferredBranchLoc;
  queryIdentity?: BranchesQueryIdentity;
  scrollElementRef: RefObject<HTMLDivElement | null>;
}) {
  // PLN-1148 Phase 2: the events-heavy merged trace is fetched lazily here. This
  // component mounts only when the Sessions & timeline tab is active (Radix
  // unmounts inactive TabsContent), so the trace loads on tab open, NOT on page
  // load. The fetched items are merged back into `detail.mergedTrace` so every
  // downstream consumer (timeline buckets, playhead, dot rail, merged trace,
  // swimlane, actor domain) reads it unchanged.
  const traceQuery = useBranchTrace(detail.id, undefined, queryIdentity);
  const detailWithTrace = useMemo<BranchPageDetail>(
    () => ({ ...detail, mergedTrace: [...(traceQuery.data ?? [])] }),
    [detail, traceQuery.data]
  );
  const actorDomain = useMemo(
    () => buildActorColorDomain(deriveActorsFromSessions(detailWithTrace)),
    [detailWithTrace]
  );
  if (traceQuery.isLoading) {
    return <BranchTraceLoading />;
  }
  return (
    <BranchTracePlayheadProvider traceItems={detailWithTrace.mergedTrace}>
      <BranchSessionsTimelineBody
        actorDomain={actorDomain}
        detail={detailWithTrace}
        key={detail.id}
        loc={loc}
        scrollElementRef={scrollElementRef}
      />
    </BranchTracePlayheadProvider>
  );
}

/** Skeleton shown while the lazy merged-trace fetch is in flight (PLN-1148). */
function BranchTraceLoading() {
  return <Skeleton className="mt-3 h-[420px] w-full" />;
}

function BranchSessionsTimelineBody({
  detail,
  actorDomain,
  loc,
  scrollElementRef,
}: {
  detail: BranchPageDetail;
  actorDomain: BranchActorColorDomain;
  loc?: PreferredBranchLoc;
  scrollElementRef: RefObject<HTMLDivElement | null>;
}) {
  const controller = useBranchTracePlayhead();
  const [isTraceEndActive, setIsTraceEndActive] = useState(false);
  const [commentsWidth, setCommentsWidth] = useState(
    DEFAULT_COMMENTS_RAIL_WIDTH
  );
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
  const {
    activeAnchor: activeTraceCommentAnchor,
    comments: traceComments,
    deleteTraceComment,
    jumpToTraceComment,
    replyToTraceComment,
    submitTraceComment,
    updateTraceComment,
  } = useTraceComments({
    target: { type: "branch", id: detail.id },
    onJumpToRow: handleScrubToRow,
  });

  // Share ONE time range (the session timeline's span) across the timeline bars,
  // the playhead handle, and the event-dot rail so they line up.
  const range = useMemo<TimeRange | null>(() => {
    const { startMs, endMs } = buildSessionTimeline(detail, actorDomain);
    return startMs != null && endMs != null
      ? { startMs, endMs, spanMs: Math.max(1, endMs - startMs) }
      : null;
  }, [detail, actorDomain]);
  const sessionCount = detail.sessions.length;
  const sessionLabel = `${sessionCount} session${sessionCount === 1 ? "" : "s"}`;
  // Read-only "you are here" position along the timeline (0–1), derived from the
  // active timestamp; null until the reader clicks the graph or trace. Updates on
  // click and on manual scroll (the draggable scrubber was removed).
  const activeFraction = useMemo(() => {
    if (isTraceEndActive) {
      return 1;
    }
    if (!(range && controller.activeTimestamp)) {
      return null;
    }
    const ms = Date.parse(controller.activeTimestamp);
    return Number.isNaN(ms) ? null : fractionOf(range, ms);
  }, [isTraceEndActive, range, controller.activeTimestamp]);

  return (
    <div
      className="bq-sessions-workspace sd3"
      style={{ "--sd3-cmts-w": `${commentsWidth}px` } as CSSProperties}
    >
      <div className="sd3-main">
        <div className="bq-page-scroll sd3-scroll" ref={scrollElementRef}>
          <div className="bq-sessions-main">
            <div className="flex flex-col gap-5">
              {/* PR timeline section — sticky: it pins to the top of the left
                  timeline scroller while the combined trace scrolls beneath.
                  Stacking mirrors the Session timeline: bars → event-dot rail →
                  time axis. A bottom border closes the section off from the
                  trace below. */}
              <div className="bq-timeline-sticky">
                <BranchPrActivityTimeline
                  activeFraction={activeFraction}
                  activeHourStart={controller.activeHourStart}
                  actorDomain={actorDomain}
                  detail={detail}
                  loc={loc}
                  onScrubHour={handleScrubToTimestamp}
                >
                  <BranchEventDotRail
                    activeRow={controller.activeRow}
                    commits={detail.commits}
                    mergedAt={detail.mergedAt}
                    onScrub={handleScrubToTimestamp}
                    openedAt={detail.openedAt}
                    prNumber={detail.prNumber}
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
                  </span>
                </div>
                <BranchMergedTrace
                  activeRow={controller.activeRow}
                  actorDomain={actorDomain}
                  highlightAnchor={activeTraceCommentAnchor}
                  onJump={handleScrubToRow}
                  onScrolledToRow={handleScrubToRow}
                  onScrolledToTraceEnd={handleScrolledToTraceEnd}
                  onSubmitTraceComment={submitTraceComment}
                  registerScroll={controller.registerTraceScroll}
                  scrollElementRef={scrollElementRef}
                  traceItems={detail.mergedTrace}
                />
              </div>

              <BranchPrSessionSwimlane
                activeTimestamp={controller.activeTimestamp}
                actorDomain={actorDomain}
                detail={detail}
                onScrubTimestamp={handleScrubToTimestamp}
                range={range}
              />
            </div>
          </div>
        </div>
      </div>

      <TraceCommentsRail
        activeRow={controller.activeRow}
        comments={traceComments}
        onDelete={deleteTraceComment}
        onJump={jumpToTraceComment}
        onReply={replyToTraceComment}
        onUpdate={updateTraceComment}
        onWidthChange={setCommentsWidth}
        width={commentsWidth}
      />
    </div>
  );
}

const DEFAULT_COMMENTS_RAIL_WIDTH = 360;

const BranchDetailState = {
  Ready: "ready",
  AwaitingSync: "awaiting-sync",
  NotPresent: "not-present",
  NoSessions: "no-sessions",
} as const;
type BranchDetailState =
  (typeof BranchDetailState)[keyof typeof BranchDetailState];

/**
 * Maps additive Branch API data-state values onto mutually exclusive detail UI
 * states. Older producers may omit `dataState`; unknown newer values fall back
 * to the pre-existing session-count behavior instead of blocking detail render.
 */
function resolveBranchDetailState(detail: BranchPageDetail): BranchDetailState {
  if (detail.dataState === BranchDataStateValue.AwaitingSync) {
    return BranchDetailState.AwaitingSync;
  }
  if (detail.dataState === BranchDataStateValue.NotPresent) {
    return BranchDetailState.NotPresent;
  }
  if (detail.dataState === BranchDataStateValue.NoSessions) {
    return BranchDetailState.NoSessions;
  }
  if (
    isReadyOrCompatDataState(detail.dataState) &&
    detail.sessions.length > 0
  ) {
    return BranchDetailState.Ready;
  }
  if (detail.sessions.length === 0) {
    return BranchDetailState.NoSessions;
  }
  return BranchDetailState.Ready;
}

function isReadyOrCompatDataState(
  dataState: BranchDataState | undefined
): dataState is typeof BranchDataStateValue.Ready | undefined {
  return dataState === undefined || dataState === BranchDataStateValue.Ready;
}
