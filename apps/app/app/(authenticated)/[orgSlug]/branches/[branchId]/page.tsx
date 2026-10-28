"use client";

import { GitHubConnectReturnStatus } from "@repo/api/src/types/github-status";
import { BRANCH_DETAIL_TAB_PARAM } from "@repo/api/src/types/notification-routes";
import {
  BranchDetailPage,
  BranchDetailRefreshState,
  classifyBranchDetailError,
  resolveBranchDetailTab,
} from "@repo/app/branches/components/branch-detail-page";
import { useAutoClearBranchRefreshState } from "@repo/app/branches/components/branch-refresh-status";
import { BranchShellView } from "@repo/app/branches/components/branch-shell-view";
import { BranchCommentsPaneToggle } from "@repo/app/branches/components/comments/branch-comments-pane-toggle";
import { BranchCommentsToggle } from "@repo/app/branches/components/comments/branch-comments-toggle";
import { useBranchCommentsControl } from "@repo/app/branches/components/comments/use-branch-comments-control";
import { BranchDetailSignalRefresh } from "@repo/app/branches/components/detail/branch-detail-signal-refresh";
import {
  GitHubConnectReturnNotice,
  GitHubConnectReturnVariant,
} from "@repo/app/branches/components/github-connect-return-notice";
import { useBranchDetail } from "@repo/app/branches/hooks/use-branches";
import {
  resolveBranchBackHref,
  resolveBranchBackLabel,
} from "@repo/app/branches/lib/branch-back-href";
import { RelatedSessionsSection } from "@repo/app/documents/components/related-sessions-section";
import {
  getRouteForSlug,
  withOrgSlug,
} from "@repo/app/documents/lib/document-navigation";
import { usePostConnectBackfill } from "@repo/app/github/hooks/use-post-connect-backfill";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useDocumentTitle } from "@repo/app/shared/hooks/use-document-title";
import { readArtifactCommentThreadId } from "@repo/app/shared/lib/artifact-comment-href";
import {
  ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY,
  SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import {
  NAV_FROM_PARAM,
  resolveNavReferrerSurface,
} from "@repo/app/shared/lib/nav-referrer";
import { useRouteParams } from "@repo/navigation/use-route-params";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useCallback, useMemo, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { claimPostConnectBackfill } from "@/lib/github-post-connect-backfill";

export default function BranchDetailRoutePage() {
  return <BranchDetailRouteContent />;
}

function BranchDetailRouteContent() {
  const orgSlug = useOrgSlug();
  const searchParams = useSearchParamsValue();
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
  const detailQuery = useBranchDetail(branchId, undefined, queryIdentity);
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
  // ISS-10980: the Activity tab's comment rows link here with `?comment=`; the
  // host that owns the URL reads it, as the Session route does.
  const selectedThreadId = readArtifactCommentThreadId(searchParams);
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
  const branchArtifactId = detailQuery.data?.artifactId;

  const handleBackfillStartError = useCallback(() => {
    setRefreshState(BranchDetailRefreshState.Error);
  }, []);
  // ISS-7338's claim is threaded in rather than held in a ref: a remount must
  // not re-fire the Apply run, and only a document navigation — how every real
  // reconnect arrives — clears it.
  const claimBackfillStart = useCallback(
    () => claimPostConnectBackfill(orgSlug),
    [orgSlug]
  );
  usePostConnectBackfill({
    claimStart: claimBackfillStart,
    enabled: githubStatus === GitHubConnectReturnStatus.Connected,
    onError: handleBackfillStartError,
  });

  // ONE read per shell, at the mount, swapping two whole pages — the shared
  // shell adoption (ISS-10797) under the same key Session detail uses.
  const shellEnabled = useFeatureFlagEnabled(
    ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY
  );
  const BranchDetailBody = shellEnabled ? BranchShellView : BranchDetailPage;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BranchDetailSignalRefresh
        branchId={branchId}
        queryIdentity={queryIdentity}
      />
      <Header
        breadcrumbs={[{ label: backLabel, href: backHref }, { label: title }]}
        suppressPageHeading
      >
        {shellEnabled ? (
          <BranchCommentsPaneToggle toggleRef={commentsControl.toggleRef} />
        ) : (
          <BranchCommentsToggle
            onOpenChange={commentsControl.onOpenChange}
            open={commentsControl.open}
            toggleRef={commentsControl.toggleRef}
          />
        )}
      </Header>
      <GitHubConnectReturnNotice
        status={githubStatus}
        variant={GitHubConnectReturnVariant.Detail}
      />
      <BranchDetailBody
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
        relatedSessionsSlot={
          // ISS-7235 AC1 — BRANCH inherits the read-only Related Sessions field
          // here, on the web shell, rather than inside `BranchDetailPage`: that
          // component also renders in the packaged desktop renderer, and
          // `related-sessions-field` is a web-only PostHog key with no Labs
          // registration (see the prop's docstring).
          //
          // Keyed on `artifactId`, never on `branchId`: `branchId` is often
          // `encodeBranchId(repo, name)` rather than an artifact UUID, and the
          // provenance route addresses ARTIFACTS. A local/legacy branch
          // projection omits `artifactId` entirely, and for those the field is
          // ABSENT rather than empty — "we cannot ask" and "nothing contributed"
          // are different facts, and only absence states neither.
          branchArtifactId ? (
            <RelatedSessionsSection artifactId={branchArtifactId} />
          ) : undefined
        }
        selectedThreadId={selectedThreadId}
      />
    </div>
  );
}
