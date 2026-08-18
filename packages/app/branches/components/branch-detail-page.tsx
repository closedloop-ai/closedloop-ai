"use client";

import type {
  BranchAnalytics,
  BranchDataState,
  BranchPageDetail,
  BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";
import { BranchDataState as BranchDataStateValue } from "@repo/api/src/types/branch";
import type { BranchSelectedPullRequestIdentity } from "@repo/api/src/types/branch-associated-pull-request";
import type { TraceTextAnchor } from "@repo/api/src/types/comment";
import { BranchDetailTabParam } from "@repo/api/src/types/notification-routes";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@repo/design-system/components/ui/primitives/underline-tabs";
import { Tabs, TabsContent } from "@repo/design-system/components/ui/tabs";
import { useMediaQuery } from "@repo/design-system/hooks/use-media-query";
import { AlertCircleIcon, GitBranchIcon } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useRef, useState } from "react";
import { PageHeading } from "../../shared/components/page-heading";
import type { BranchesQueryIdentity } from "../hooks/use-branches";
import {
  type BranchBackLabel,
  BranchBackLabel as BranchBackLabelValue,
} from "../lib/branch-back-href";
import { resolvePreferredBranchLoc } from "../lib/preferred-branch-loc";
import {
  BranchDetailLoading,
  BranchDetailNotFound,
  BranchDetailProviderError,
} from "./branch-detail-states";
import { BranchPropertiesPanel } from "./branch-properties-panel";
import { BranchRefreshState } from "./branch-refresh-status";
import { BranchCommentsController } from "./comments/branch-comments-controller";
import type { BranchCommentDraftTarget } from "./comments/branch-comments-model";
import { BranchCommentsTab } from "./comments/branch-comments-model";
import { BranchCommentsToggle } from "./comments/branch-comments-toggle";
import { useBranchCommentsControl } from "./comments/use-branch-comments-control";
import { BranchSelectedPullRequestWorkspace } from "./detail/branch-selected-pull-request-workspace";
import { BranchSessionsTimelineTab } from "./detail/branch-sessions-timeline-tab";

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
 * reader, all bound to one shared playhead controller) are mounted. The
 * "What was delivered" section (linked PR artifacts + read-only PR description),
 * the PR status panel, and the files-changed panel read the cloud branch
 * projection; PLN-1535 M5.3 removed the live GitHub-gateway overlay lane that
 * used to back them, along with its `allowLiveOverlays` plumbing and the
 * app-focus/manual overlay refresh control.
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
  backHref: string;
  /**
   * FEA-4262: the "Back" affordance's destination label, paired with `backHref`
   * by `resolveBranchBackLabel` so the error-state link's text always matches
   * where it goes. Defaults to "Branches" (the static fallback destination);
   * a session referrer (`?from=session`) resolves it to "Sessions".
   */
  backLabel?: BranchBackLabel;
  /**
   * FEA-4257: build the org-relative session-detail href for a session listed
   * in the "Sessions & timeline" swimlane, so each lane navigates to that
   * session (the branch→session seam). Receives the session artifact id. The
   * web and desktop shells inject their own path shape; omitted → the lanes stay
   * non-links (the burst scrub still works).
   */
  getSessionHref?: (sessionId: string) => string;
  /**
   * FEA-4292: build the org-relative href for a recognized Closedloop artifact
   * listed in "What was delivered" (the branch's `linkedArtifacts`, keyed on the
   * slug embedded in the branch name), so each renders as an in-app link to its
   * canonical record — consistent with how Session Properties links the same
   * relationship. Receives the artifact slug; returns null when the slug is not a
   * navigable typed slug. The web shell injects an org-relative route; Desktop
   * injects the equivalent absolute web-app route because its native router does
   * not host document detail pages.
   */
  getArtifactHref?: (slug: string) => string | null;
  /**
   * Tab to open on first render. Defaults to `branch-details`. A mention-
   * notification deep-link passes `sessions-timeline` (via `?tab=`) so the
   * trace-comments rail — mounted only under that tab — is on screen when the
   * user lands here from the inbox (FEA-3490).
   */
  initialTab?: BranchDetailTab;
  /**
   * Header-owned comments state for production shells. When omitted (stories
   * and focused component tests), the page owns the same state and renders the
   * toggle beside its tab navigation.
   */
  commentsControl?: BranchCommentsControl;
};

const NARROW_COMMENTS_QUERY = "(max-width: 1024px)";

export type BranchCommentsControl = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  toggleRef: RefObject<HTMLButtonElement | null>;
};

export const BranchDetailErrorKind = {
  NotPresent: "not-present",
  ProviderError: "provider-error",
} as const;
export type BranchDetailErrorKind =
  (typeof BranchDetailErrorKind)[keyof typeof BranchDetailErrorKind];

export const BranchDetailRefreshState = BranchRefreshState;
export type BranchDetailRefreshState = BranchRefreshState;

// The tab literals are owned by the notification-route SSOT (`BranchDetailTabParam`)
// so a mention deep-link's `?tab=` value and this page's tab ids can never drift.
type BranchDetailTab = BranchDetailTabParam;

const TAB_BRANCH_DETAILS: BranchDetailTab = BranchDetailTabParam.BranchDetails;
const TAB_SESSIONS_TIMELINE: BranchDetailTab =
  BranchDetailTabParam.SessionsTimeline;

/**
 * Narrow a raw `?tab=` query value to a known `BranchDetailTab`, or `undefined`
 * when it is absent/unrecognized (so the page falls back to its default tab).
 * Used by the branch route to honor mention-notification deep-links.
 */
export function resolveBranchDetailTab(
  raw: string | null | undefined
): BranchDetailTab | undefined {
  if (
    raw === BranchDetailTabParam.BranchDetails ||
    raw === BranchDetailTabParam.SessionsTimeline
  ) {
    return raw;
  }
  return undefined;
}

export function BranchDetailPage({ ...props }: BranchDetailPageProps) {
  return (
    <BranchDetailPageContent
      {...props}
      key={props.detail?.id ?? props.branchId}
    />
  );
}

function BranchDetailPageContent({
  branchId,
  detail,
  analytics,
  isLoading,
  isError,
  errorKind,
  refreshState = BranchDetailRefreshState.Idle,
  queryIdentity,
  backHref,
  backLabel = BranchBackLabelValue.Branches,
  getArtifactHref,
  initialTab = TAB_BRANCH_DETAILS,
  commentsControl,
}: BranchDetailPageProps) {
  const [activeTab, setActiveTab] = useState<BranchDetailTab>(initialTab);
  const [commentsContext, setCommentsContext] = useState<{
    comments?: BranchPrCommentsResponse;
    error: boolean;
    loading: boolean;
    pullRequestKey: string | null;
  }>({ error: false, loading: false, pullRequestKey: null });
  const [commentComposerTarget, setCommentComposerTarget] =
    useState<BranchCommentDraftTarget | null>(null);
  const [pendingCommentJump, setPendingCommentJump] =
    useState<TraceTextAnchor | null>(null);
  const [selectedPullRequest, setSelectedPullRequest] =
    useState<BranchSelectedPullRequestIdentity | null>(null);
  const [renderedCommentsSessions, setRenderedCommentsSessions] = useState<{
    coverageNote: string | null;
    sessionIds: readonly string[];
  }>({ coverageNote: null, sessionIds: [] });
  // The Sessions & timeline tab owns this scroller inside its `.sd3-main`, so
  // the comments rail can sit beside it as a page-level sibling.
  const sessionsScrollRef = useRef<HTMLDivElement>(null);
  const internalCommentsControl = useBranchCommentsControl(branchId);
  const resolvedCommentsControl = commentsControl ?? internalCommentsControl;
  const commentsOpen = resolvedCommentsControl.open;
  const setCommentsOpen = resolvedCommentsControl.onOpenChange;
  const commentsToggleRef = resolvedCommentsControl.toggleRef;
  const commentsUseSheet = useMediaQuery(NARROW_COMMENTS_QUERY);

  // Resolve changed-LOC once from the projection and pass it to every
  // detail-page LOC consumer, so one branch cannot report two sizes.
  const preferredLoc = resolvePreferredBranchLoc(detail);

  // Loading takes priority while the first detail read is still pending, so the
  // two-column layout is stable before the hooks resolve.
  if (isLoading && !detail) {
    return <BranchDetailLoading />;
  }

  if (isError && !detail) {
    return errorKind === BranchDetailErrorKind.NotPresent ? (
      <BranchDetailNotFound backHref={backHref} backLabel={backLabel} />
    ) : (
      <BranchDetailProviderError backHref={backHref} backLabel={backLabel} />
    );
  }

  if (!detail) {
    return <BranchDetailNotFound backHref={backHref} backLabel={backLabel} />;
  }

  const detailState = resolveBranchDetailState(detail);
  const hasSessions = detailState === BranchDetailState.Ready;
  const emptyDetailState = renderBranchEmptyDetailState(detailState);

  const content = (
    <div className="flex min-h-0 flex-1">
      <Tabs
        // No flex gap: the underline navigation and active panel own their
        // spacing independently.
        className="flex min-h-0 w-full flex-1 flex-col gap-0"
        onValueChange={(value) => setActiveTab(value as BranchDetailTab)}
        value={activeTab}
      >
        {/* The page subject as a visually-hidden heading: the visible branch
              name/metadata lives in the Properties panel (no duplicate chrome),
              but the page still owns an in-body <h1> for heading-order/landmark
              navigation per the project's page-title convention. */}
        {/* The crumb and the heading must be the same string: the shell Header
              is suppressed on this route, and its default carried the crumb
              text verbatim (ISS-5008 review). */}
        <PageHeading>{detail.branchName}</PageHeading>
        {refreshState === BranchDetailRefreshState.Error ? (
          <Alert className="mx-5 mt-3" variant="error">
            <AlertTitle>Latest branch details unavailable</AlertTitle>
            <AlertDescription>
              Showing the most recent branch details we could load. Newer
              provider data may not appear yet.
            </AlertDescription>
          </Alert>
        ) : null}
        {hasSessions ? (
          <>
            <div className="flex shrink-0 items-center border-b">
              <UnderlineTabsList className="min-w-0 flex-1 border-b-0">
                <UnderlineTabsTrigger value={TAB_BRANCH_DETAILS}>
                  Branch details
                </UnderlineTabsTrigger>
                <UnderlineTabsTrigger value={TAB_SESSIONS_TIMELINE}>
                  Sessions &amp; timeline
                </UnderlineTabsTrigger>
              </UnderlineTabsList>
              {commentsControl ? null : (
                <div className="mr-4 shrink-0">
                  <BranchCommentsToggle
                    onOpenChange={setCommentsOpen}
                    open={commentsOpen}
                    toggleRef={commentsToggleRef}
                  />
                </div>
              )}
            </div>
            <TabsContent
              className="bq-page-scroll mx-auto min-h-0 w-full max-w-[1000px] flex-1 overflow-auto px-5 pt-4 pb-6"
              value={TAB_BRANCH_DETAILS}
            >
              {/* Properties belong to the Branch details tab only (collapsed
                      by default) — matches the Branches Page design handoff. */}
              <BranchPropertiesPanel detail={detail} loc={preferredLoc} />
              <BranchSelectedPullRequestWorkspace
                analytics={analytics}
                branchId={branchId}
                detail={detail}
                getArtifactHref={getArtifactHref}
                key={detail.id}
                loc={preferredLoc}
                onCommentsContextChange={setCommentsContext}
                onSelectionChange={setSelectedPullRequest}
                queryIdentity={queryIdentity}
                selection={selectedPullRequest}
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
                onComposerTargetChange={(target) => {
                  setCommentComposerTarget(target);
                  if (target) {
                    setCommentsOpen(true);
                  }
                }}
                onRenderedSessionsChange={setRenderedCommentsSessions}
                pendingJumpAnchor={pendingCommentJump}
                queryIdentity={queryIdentity}
                scrollElementRef={sessionsScrollRef}
              />
            </TabsContent>
          </>
        ) : (
          emptyDetailState
        )}
      </Tabs>
      <BranchCommentsController
        activeTab={
          activeTab === TAB_BRANCH_DETAILS
            ? BranchCommentsTab.Details
            : BranchCommentsTab.Sessions
        }
        composerTarget={commentComposerTarget}
        detail={detail}
        onClose={() => setCommentsOpen(false)}
        onJump={(anchor) => {
          setPendingCommentJump(anchor);
          setActiveTab(TAB_SESSIONS_TIMELINE);
          if (commentsUseSheet) {
            setCommentsOpen(false);
          }
        }}
        open={commentsOpen}
        providerComments={commentsContext.comments}
        providerError={commentsContext.error}
        providerLoading={commentsContext.loading}
        renderedSessionIds={renderedCommentsSessions.sessionIds}
        returnFocusRef={commentsToggleRef}
        selectedPullRequestKey={commentsContext.pullRequestKey}
        sessionsCoverageNote={renderedCommentsSessions.coverageNote}
      />
    </div>
  );

  return content;
}

export function classifyBranchDetailError(
  error: unknown
): BranchDetailErrorKind {
  if (error instanceof ApiError && error.isNotFound()) {
    return BranchDetailErrorKind.NotPresent;
  }
  return BranchDetailErrorKind.ProviderError;
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
