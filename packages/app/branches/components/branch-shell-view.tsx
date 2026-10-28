"use client";

import {
  BranchDataState,
  type BranchPageDetail,
} from "@repo/api/src/types/branch";
import type { BranchSelectedPullRequestIdentity } from "@repo/api/src/types/branch-associated-pull-request";
import type { TraceTextAnchor } from "@repo/api/src/types/comment";
import { SharedAnalyticsComponent } from "@repo/api/src/types/surface-analytics";
import { ArtifactCanvasPanel } from "@repo/app/shared/components/artifact-detail-shell/artifact-canvas-panel";
import { ArtifactDetailShell } from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell";
import { useArtifactDetailTabRoute } from "@repo/app/shared/components/artifact-detail-shell/use-artifact-detail-tab-route";
import { showCommentsPaneTransiently } from "@repo/app/shared/components/comments/use-comments-pane-state";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import { useSharedComponentRenderedEvent } from "@repo/app/shared/observability/surface-analytics-context";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import type { ReactNode } from "react";
import { useCallback, useRef, useState } from "react";
import { PageHeading } from "../../shared/components/page-heading";
import { useBranchTracePages } from "../hooks/use-branch-trace-pages";
import { resolvePreferredBranchLoc } from "../lib/preferred-branch-loc";
import {
  BRANCH_ARTIFACT_ROUTE_CONFIG,
  BRANCH_ARTIFACT_TABS,
} from "./branch-artifact-routing";
import {
  BranchDetailPage,
  type BranchDetailPageProps,
  BranchDetailRefreshState,
} from "./branch-detail-page";
import { BranchShellCollaborators } from "./branch-shell-collaborators";
import { BranchShellDetails } from "./branch-shell-details";
import {
  BRANCH_COMMENTS_PANE_KEYS,
  type BranchCommentDraftTarget,
  type BranchRenderedSessions,
} from "./comments/branch-comments-model";
import { BranchCommentsPane } from "./comments/branch-comments-pane";
import { BranchCommentsPaneToggle } from "./comments/branch-comments-pane-toggle";
import { BranchSelectedPullRequestWorkspace } from "./detail/branch-selected-pull-request-workspace";
import { BranchSessionsTimelinePanel } from "./detail/branch-sessions-timeline-tab";
import { BranchShellActivity } from "./detail/branch-shell-activity";

/**
 * ISS-10797: Branch detail on the canonical shell.
 *
 * Today's two tabs become two shell panels — "Branch details" is Artifact
 * (Kerensa Whitlock's ruling on ISS-10963, so the PR selector scopes every PR-owned
 * panel on one tab) and "Sessions & timeline" is Sessions. The selected PR
 * therefore lives HERE rather than inside either panel, because it scopes the
 * Artifact panel while the Sessions panel is mounted beside it.
 *
 * The trace fetch moves out of `BranchSessionsTimelineTab` into this adapter,
 * which is what ISS-10793 left for this ticket; the panel has always taken
 * `trace` as props.
 *
 * Collaborators ride in the header as well as in Details (operator ruling,
 * ISS-12267, superseding ISS-10963's Details-only design), using the Branches
 * list's collaborators widget. The Properties card is gone: Name, Status and
 * the rest of its rows live in Details.
 *
 * Details ships READ-ONLY (operator ruling, 2026-10-06). Making those fields
 * writable is ISS-10995, which this ticket now blocks.
 *
 * Activity reads `GET /branches/[id]/activity` since ISS-10980; the
 * `unsupported` tab state it carried before that is gone.
 */
/**
 * A drop-in for `BranchDetailPage`: same props, so a host swaps one component
 * for the other on one flag read and passes its existing inputs unchanged.
 */
export function BranchShellView(props: BranchDetailPageProps) {
  const { branchId, detail, getArtifactHref, queryIdentity } = props;
  const route = useArtifactDetailTabRoute(BRANCH_ARTIFACT_ROUTE_CONFIG);
  const [selectedPullRequest, setSelectedPullRequest] =
    useState<BranchSelectedPullRequestIdentity | null>(null);
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  // PLN-2162 M6: the pane returns focus to the host header's toggle where the
  // host owns one; stories and tests get the shell's own.
  const fallbackToggleRef = useRef<HTMLButtonElement>(null);
  const toggleRef = props.commentsControl?.toggleRef ?? fallbackToggleRef;
  const [selectedPullRequestKey, setSelectedPullRequestKey] = useState<
    string | null
  >(null);
  const [renderedSessions, setRenderedSessions] =
    useState<BranchRenderedSessions>(NO_RENDERED_SESSIONS);
  const [composerTarget, setComposerTarget] =
    useState<BranchCommentDraftTarget | null>(null);
  const [pendingJumpAnchor, setPendingJumpAnchor] =
    useState<TraceTextAnchor | null>(null);
  const onCommentsContextChange = useCallback(
    (context: { pullRequestKey: string | null }) =>
      setSelectedPullRequestKey(context.pullRequestKey),
    []
  );
  // A timeline selection opens the pane on its composer, as it did the rail,
  // for this visit only (ISS-12300 D6).
  const onComposerTargetChange = useCallback(
    (target: BranchCommentDraftTarget | null) => {
      setComposerTarget(target);
      if (target) {
        showCommentsPaneTransiently(BRANCH_COMMENTS_PANE_KEYS.sessions.open);
      }
    },
    []
  );
  // Lifted out of the Sessions tab per ISS-10797, and GATED, because the lift
  // alone would make it eager: the legacy page got laziness from Radix
  // unmounting the inactive tab, and this adapter is always mounted. Sessions
  // is not in `keepMountedTabs`, so the shell's contract puts the visibility
  // gate on the host. `detail?.id` keeps the hook order stable across the
  // absence delegation below.
  const traceQuery = useBranchTracePages(
    detail?.id ?? "",
    {
      enabled:
        Boolean(detail?.id) && route.activeTab === ArtifactDetailTab.Sessions,
    },
    queryIdentity
  );

  // Loading, not-found and provider-unavailable stay with `BranchDetailPage`,
  // which already renders all three with the Back link and the NotPresent
  // split. Reimplementing them here would be a second answer to one question.
  //
  // A LOADED detail can still be one of those states: `dataState` carries
  // awaiting-sync and not-present on a row that otherwise looks complete, and
  // ISS-10963 says both "replace the whole shell". Delegating is what makes
  // that true — without it a branch the provider says is gone renders four
  // normal tabs and its properties, telling the user nothing (tamsinb, #8514).
  //
  // NoSessions is deliberately NOT here: ISS-10963 moves it into the Sessions
  // tab body rather than replacing the page, so it falls through to the shell.
  if (!detail || isWholePageBranchState(detail.dataState)) {
    return <BranchDetailPage {...props} />;
  }
  // One LOC read for every panel, as the page resolves it once today.
  const preferredLoc = resolvePreferredBranchLoc(detail);

  return (
    <BranchShellMountEvent>
      {/* Page chrome, above the shell and outside the tab system. The heading
          is the page's only h1 (sr-only). The alert is a GitHub backfill-start
          failure (ISS-12225), not a statement about any tab's data, which is
          what `stale` means — so it is not a tab state. Both carried over from
          the legacy page verbatim (tamsinb, #8514). */}
      <PageHeading>{detail.branchName}</PageHeading>
      {props.refreshState === BranchDetailRefreshState.Error ? (
        <Alert className="mx-5 mt-3" variant="error">
          <AlertTitle>Latest branch details unavailable</AlertTitle>
          <AlertDescription>
            Showing the most recent branch details we could load. Newer provider
            data may not appear yet.
          </AlertDescription>
        </Alert>
      ) : null}
      <ArtifactDetailShell
        activeTab={route.activeTab}
        comments={
          <BranchCommentsPane
            activeTab={route.activeTab}
            addressedThreadId={props.selectedThreadId}
            branchArtifactId={detail.artifactId ?? null}
            composerTarget={composerTarget}
            onRevealTraceAnchor={setPendingJumpAnchor}
            onSelectPullRequest={setSelectedPullRequest}
            renderedSessions={renderedSessions}
            returnFocusRef={toggleRef}
            selectedPullRequestKey={selectedPullRequestKey}
            selectTabThenReveal={route.selectTabThenReveal}
          />
        }
        headerEnd={
          <>
            <BranchShellCollaborators branchId={detail.id} />
            {props.commentsControl ? null : (
              <BranchCommentsPaneToggle toggleRef={fallbackToggleRef} />
            )}
          </>
        }
        keepMountedTabs={[ArtifactDetailTab.Artifact]}
        key={detail.id}
        onActivePanelReady={route.onActivePanelReady}
        onActiveTabChange={route.setActiveTab}
        panels={{
          // Each panel carries the container the legacy page gave its own
          // `TabsContent`. The shell contributes `flex min-h-0 flex-1 flex-col`
          // and nothing else, so a panel that brings no scroll or padding of its
          // own renders with neither.
          // ISS-12412: Artifact, Details and Activity sit on the one framed
          // canvas card, which is each tab's scroll container.
          [ArtifactDetailTab.Artifact]: (
            <ArtifactCanvasPanel label="Branch">
              <BranchSelectedPullRequestWorkspace
                branchId={branchId}
                detail={detail}
                getArtifactHref={getArtifactHref}
                key={detail.id}
                onCommentsContextChange={onCommentsContextChange}
                onSelectionChange={setSelectedPullRequest}
                queryIdentity={queryIdentity}
                selection={selectedPullRequest}
              />
            </ArtifactCanvasPanel>
          ),
          [ArtifactDetailTab.Details]: (
            <ArtifactCanvasPanel label="Branch details">
              <BranchShellDetails
                detail={detail}
                getArtifactHref={getArtifactHref}
                getSessionHref={props.getSessionHref}
                loc={preferredLoc}
              />
            </ArtifactCanvasPanel>
          ),
          [ArtifactDetailTab.Sessions]: (
            // Containment only: the timeline owns its scroller
            // (`bq-page-scroll sd3-scroll`, bound to `scrollElementRef`), which
            // needs an overflow-hidden parent to size against.
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <BranchSessionsTimelinePanel
                detail={detail}
                getSessionHref={props.getSessionHref}
                loc={preferredLoc}
                onComposerTargetChange={onComposerTargetChange}
                onRenderedSessionsChange={setRenderedSessions}
                pendingJumpAnchor={pendingJumpAnchor}
                scrollElementRef={scrollElementRef}
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
            </div>
          ),
          // ISS-10980: the live feed, replacing the shell's `unsupported`
          // state. The panel owns its own read, so it is mounted only while
          // Activity is the active tab (Activity is not in `keepMountedTabs`).
          [ArtifactDetailTab.Activity]: (
            <ArtifactCanvasPanel label="Branch activity">
              <BranchShellActivity branchId={detail.id} />
            </ArtifactCanvasPanel>
          ),
        }}
        tabs={BRANCH_ARTIFACT_TABS}
      />
    </BranchShellMountEvent>
  );
}

const NO_RENDERED_SESSIONS = {
  coverageNote: null,
  sessionIds: [],
} as const satisfies BranchRenderedSessions;

/**
 * `awaiting_sync` and `not_present` arrive on a detail that is otherwise
 * loaded, and ISS-10963 has both replace the whole shell. `no_sessions` is
 * excluded on purpose — that one becomes the Sessions tab body.
 */
function isWholePageBranchState(dataState: BranchPageDetail["dataState"]) {
  return (
    dataState === BranchDataState.AwaitingSync ||
    dataState === BranchDataState.NotPresent
  );
}

/**
 * The `branch_detail_page` event fires HERE and not at the top of the adapter,
 * because every delegating path returns `BranchDetailPage`, which fires its own
 * from its own hook. Firing in both places double-counted every cold open
 * (tamsinb, #8514).
 */
function BranchShellMountEvent({ children }: { children: ReactNode }) {
  useSharedComponentRenderedEvent(SharedAnalyticsComponent.BranchDetailPage);
  return <>{children}</>;
}
