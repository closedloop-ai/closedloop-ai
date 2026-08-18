"use client";

import { GitHubBackfillMode } from "@repo/api/src/types/github";
import { GitHubConnectReturnStatus } from "@repo/api/src/types/github-status";
import { BRANCH_DETAIL_TAB_PARAM } from "@repo/api/src/types/notification-routes";
import {
  BranchDetailPage,
  BranchDetailRefreshState,
  classifyBranchDetailError,
  resolveBranchDetailTab,
} from "@repo/app/branches/components/branch-detail-page";
import { useAutoClearBranchRefreshState } from "@repo/app/branches/components/branch-refresh-status";
import { BranchCommentsToggle } from "@repo/app/branches/components/comments/branch-comments-toggle";
import { useBranchCommentsControl } from "@repo/app/branches/components/comments/use-branch-comments-control";
import {
  GitHubConnectReturnNotice,
  GitHubConnectReturnVariant,
} from "@repo/app/branches/components/github-connect-return-notice";
import {
  branchesKeys,
  useBranchAnalytics,
  useBranchDetail,
} from "@repo/app/branches/hooks/use-branches";
import {
  resolveBranchBackHref,
  resolveBranchBackLabel,
} from "@repo/app/branches/lib/branch-back-href";
import {
  getRouteForSlug,
  withOrgSlug,
} from "@repo/app/documents/lib/document-navigation";
import { githubKeys } from "@repo/app/github/hooks/use-github-integration";
import { LONG_RUNNING_API_TIMEOUT_MS } from "@repo/app/shared/api/api-timeout";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useDocumentTitle } from "@repo/app/shared/hooks/use-document-title";
import { SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  NAV_FROM_PARAM,
  resolveNavReferrerSurface,
} from "@repo/app/shared/lib/nav-referrer";
import { useRouteParams } from "@repo/navigation/use-route-params";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { useOrgSlug } from "@/hooks/use-org-slug";

const WEB_BRANCH_DETAIL_STALE_TIME_MS = 30_000;

export default function BranchDetailRoutePage() {
  return <BranchDetailRouteContent />;
}

function BranchDetailRouteContent() {
  const orgSlug = useOrgSlug();
  const searchParams = useSearchParamsValue();
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const backfillStartedRef = useRef(false);
  const params = useRouteParams();
  const branchId = typeof params.branchId === "string" ? params.branchId : "";
  const queryIdentity = useMemo(
    () => ({ cacheScope: `org:${orgSlug}` }),
    [orgSlug]
  );
  const [refreshState, setRefreshState] = useState<BranchDetailRefreshState>(
    BranchDetailRefreshState.Idle
  );
  const commentsControl = useBranchCommentsControl(branchId);
  useAutoClearBranchRefreshState(refreshState, setRefreshState);
  const detailQuery = useBranchDetail(
    branchId,
    {
      staleTime: WEB_BRANCH_DETAIL_STALE_TIME_MS,
      refetchOnWindowFocus: true,
    },
    queryIdentity
  );
  const analyticsQuery = useBranchAnalytics(
    {},
    {
      staleTime: WEB_BRANCH_DETAIL_STALE_TIME_MS,
      refetchOnWindowFocus: true,
    },
    queryIdentity
  );
  const branchesHref = `/${orgSlug}/branches`;
  const sessionsHref = `/${orgSlug}/sessions`;
  // FEA-4262: when this page was opened via a session's Branch cross-link
  // (`?from=session`), Back returns to the sessions list the user came from
  // instead of the static branches list. Absent/unknown referrer → branches.
  const referrerSurface = resolveNavReferrerSurface(
    searchParams.get(NAV_FROM_PARAM)
  );
  const backHref = resolveBranchBackHref({
    branchesHref,
    from: referrerSurface,
    sessionsHref,
  });
  // Drive the breadcrumb parent segment AND the error-state back link from the
  // same resolved destination as backHref, so on a loaded branch opened via
  // `?from=session` the header's "Back" also returns to Sessions (not just the
  // error states) and its label matches where it goes.
  const backLabel = resolveBranchBackLabel({
    from: referrerSurface,
    sessionsHref,
  });
  // FEA-4257: link each swimlane lane to its session's detail page.
  const getSessionHref = useCallback(
    (sessionId: string) => `/${orgSlug}/sessions/${sessionId}`,
    [orgSlug]
  );
  // FEA-4292: org-scoped href to a linked Closedloop artifact in "What was
  // delivered", derived from the slug embedded in the branch name. Same seam
  // Session Properties uses (`withOrgSlug` + a slug→route resolver); null for a
  // non-navigable/untyped slug so that row renders as a plain label.
  const getArtifactHref = useCallback(
    (slug: string) => withOrgSlug(orgSlug, getRouteForSlug(slug)),
    [orgSlug]
  );
  const githubStatus = searchParams.get("github");
  // Honor a mention-notification deep-link's `?tab=` so the trace-comments rail
  // (mounted only under the sessions-timeline tab) is on screen on arrival.
  const initialTab = resolveBranchDetailTab(
    searchParams.get(BRANCH_DETAIL_TAB_PARAM)
  );
  const title = detailQuery.data?.branchName ?? "Branch";
  // ISS-5574: name the tab for this record, reusing the SAME `title` the page
  // heading renders so the tab and the heading cannot drift. Its `"Branch"`
  // fallback is the honest generic while the read is in flight or the branch has
  // no name — never a placeholder that would read as one.
  const tabTitlesEnabled = useFeatureFlagEnabled(
    SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY
  );
  useDocumentTitle(tabTitlesEnabled ? title : null);
  const errorKind = classifyBranchDetailError(detailQuery.error);

  useEffect(() => {
    if (githubStatus !== GitHubConnectReturnStatus.Connected) {
      return;
    }
    queryClient.invalidateQueries({ queryKey: githubKeys.all });
    queryClient.invalidateQueries({ queryKey: branchesKeys.all });
    if (backfillStartedRef.current) {
      return;
    }
    backfillStartedRef.current = true;
    // Long-running by design: Apply mode runs the whole backfill (repos ->
    // branches -> PRs -> projections) synchronously before responding, so it
    // needs more than the default client deadline.
    const backfill = apiClient.post(
      "/integrations/github/backfill",
      { mode: GitHubBackfillMode.Apply },
      { timeoutMs: LONG_RUNNING_API_TIMEOUT_MS }
    );
    backfill
      .catch(() => {
        setRefreshState(BranchDetailRefreshState.Error);
      })
      // Settled, not success — same reason as the Branches list (ISS-5013): an
      // abandoned Apply-mode run can still have written rows, and a stale
      // population would then assert "nothing here" about data that exists.
      .finally(() => {
        queryClient.invalidateQueries({ queryKey: branchesKeys.all });
      });
  }, [apiClient, githubStatus, queryClient]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        breadcrumbs={[{ label: backLabel, href: backHref }, { label: title }]}
        suppressPageHeading
      >
        <BranchCommentsToggle
          onOpenChange={commentsControl.onOpenChange}
          open={commentsControl.open}
          toggleRef={commentsControl.toggleRef}
        />
      </Header>
      <GitHubConnectReturnNotice
        status={githubStatus}
        variant={GitHubConnectReturnVariant.Detail}
      />
      <BranchDetailPage
        analytics={analyticsQuery.data}
        backHref={backHref}
        backLabel={backLabel}
        branchId={branchId}
        commentsControl={commentsControl}
        detail={detailQuery.data}
        errorKind={errorKind}
        getArtifactHref={getArtifactHref}
        getSessionHref={getSessionHref}
        initialTab={initialTab}
        isError={detailQuery.isError}
        isLoading={detailQuery.isLoading}
        queryIdentity={queryIdentity}
        refreshState={refreshState}
      />
    </div>
  );
}
