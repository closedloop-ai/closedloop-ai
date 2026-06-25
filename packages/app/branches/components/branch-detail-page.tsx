"use client";

import type {
  BranchAnalytics,
  BranchPageDetail,
  BranchUsageSummary,
} from "@repo/api/src/types/branch";
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
import { useMemo, useState } from "react";
import {
  type BranchActorColorDomain,
  buildActorColorDomain,
  deriveActorsFromSessions,
} from "../lib/branch-actor-domain";
import { buildSessionTimeline } from "../lib/branch-session-buckets";
import type { TimeRange } from "../lib/branch-timeline-range";
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
import { BranchTracePlayhead } from "./branch-trace-playhead";
import { BranchDeliveredPanel } from "./detail/branch-delivered-panel";
import { BranchFilesChangedPanel } from "./detail/branch-files-changed-panel";

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
  usage?: BranchUsageSummary;
  analytics?: BranchAnalytics;
  isLoading: boolean;
  isError: boolean;
  backHref: string;
};

type BranchDetailTab = "branch-details" | "sessions-timeline";

const TAB_BRANCH_DETAILS: BranchDetailTab = "branch-details";
const TAB_SESSIONS_TIMELINE: BranchDetailTab = "sessions-timeline";

export function BranchDetailPage({
  detail,
  analytics,
  isLoading,
  isError,
  backHref,
}: BranchDetailPageProps) {
  const [activeTab, setActiveTab] =
    useState<BranchDetailTab>(TAB_BRANCH_DETAILS);

  // Resolve changed-LOC once, preferring the connected PR's live totals over
  // enrichment (FEA-1952). Shared with the files panel's overlay query key, so
  // React Query dedupes to one fetch; passed to every detail-page LOC consumer.
  // Called before the early returns (Rules of Hooks); tolerates undefined detail.
  const preferredLoc = usePreferredBranchLoc(detail);

  // Loading takes priority while the first detail read is still pending, so the
  // two-column layout is stable before the hooks resolve.
  if (isLoading && !detail) {
    return <BranchDetailLoading />;
  }

  // The local source rejects a missing branch with ApiError(404); a sanitized
  // 500 lands here too. Either way the branch can't be shown — render not-found.
  if (isError || !detail) {
    return <BranchDetailNotFound backHref={backHref} />;
  }

  const hasSessions = detail.sessions.length > 0;

  return (
    <BranchesOverlayRefreshProvider>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {/* The page subject as a visually-hidden heading: the visible branch
              name/metadata lives in the Properties panel (no duplicate chrome),
              but the page still owns an in-body <h1> for heading-order/landmark
              navigation per the project's page-title convention. */}
          <h1 className="sr-only">Branch {detail.branchName}</h1>
          {hasSessions ? (
            <div className="mx-auto w-full max-w-[1000px] px-5 py-4">
              {/* Properties sits above the tabs (collapsed by default) — matches
                the Branches Page design handoff. */}
              <BranchPropertiesPanel detail={detail} loc={preferredLoc} />
              <Tabs
                className="mt-3 gap-4"
                onValueChange={(value) =>
                  setActiveTab(value as BranchDetailTab)
                }
                value={activeTab}
              >
                <TabsList>
                  <TabsTrigger value={TAB_BRANCH_DETAILS}>
                    Branch details
                  </TabsTrigger>
                  <TabsTrigger value={TAB_SESSIONS_TIMELINE}>
                    Sessions &amp; timeline
                  </TabsTrigger>
                </TabsList>
                <TabsContent value={TAB_BRANCH_DETAILS}>
                  {detail.multiPrWarning ? (
                    <BranchMultiPrNotice
                      linkedPrNumbers={detail.linkedPrNumbers}
                    />
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
                  <BranchFilesChangedPanel detail={detail} />
                </TabsContent>
                <TabsContent value={TAB_SESSIONS_TIMELINE}>
                  <BranchSessionsTimelineTab
                    detail={detail}
                    loc={preferredLoc}
                  />
                </TabsContent>
              </Tabs>
            </div>
          ) : (
            <div className="px-5 py-4">
              <BranchNoSessionsState />
            </div>
          )}
        </div>
      </div>
    </BranchesOverlayRefreshProvider>
  );
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

function BranchNoSessionsState() {
  return (
    <EmptyState
      description="Sessions appear here once an agent works this branch. There's nothing to show yet."
      icon={GitBranchIcon}
      title="No sessions on this branch yet"
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
}: {
  detail: BranchPageDetail;
  loc?: PreferredBranchLoc;
}) {
  const actorDomain = useMemo(
    () => buildActorColorDomain(deriveActorsFromSessions(detail)),
    [detail]
  );
  return (
    <BranchTracePlayheadProvider traceItems={detail.mergedTrace}>
      <BranchSessionsTimelineBody
        actorDomain={actorDomain}
        detail={detail}
        loc={loc}
      />
    </BranchTracePlayheadProvider>
  );
}

function BranchSessionsTimelineBody({
  detail,
  actorDomain,
  loc,
}: {
  detail: BranchPageDetail;
  actorDomain: BranchActorColorDomain;
  loc?: PreferredBranchLoc;
}) {
  const controller = useBranchTracePlayhead();
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

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="relative">
          <BranchPrActivityTimeline
            activeHourStart={controller.activeHourStart}
            actorDomain={actorDomain}
            detail={detail}
            loc={loc}
            onScrubHour={controller.scrubToTimestamp}
          />
          <div className="bq-playhead-overlay">
            <BranchTracePlayhead range={range} />
          </div>
        </div>
        <BranchEventDotRail
          activeRow={controller.activeRow}
          commits={detail.commits}
          mergedAt={detail.mergedAt}
          onScrub={controller.scrubToTimestamp}
          openedAt={detail.openedAt}
          prNumber={detail.prNumber}
          range={range}
          traceItems={detail.mergedTrace}
        />
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
          onJump={controller.scrubToRow}
          registerScroll={controller.registerTraceScroll}
          traceItems={detail.mergedTrace}
        />
      </div>

      <BranchPrSessionSwimlane
        activeTimestamp={controller.activeTimestamp}
        actorDomain={actorDomain}
        detail={detail}
        onScrubTimestamp={controller.scrubToTimestamp}
        range={range}
      />
    </div>
  );
}
