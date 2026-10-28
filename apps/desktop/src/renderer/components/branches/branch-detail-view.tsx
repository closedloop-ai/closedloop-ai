import { BRANCH_DETAIL_TAB_PARAM } from "@repo/api/src/types/notification-routes";
import {
  type BranchCommentsControl,
  BranchDetailPage,
  classifyBranchDetailError,
  resolveBranchDetailTab,
} from "@repo/app/branches/components/branch-detail-page";
import { BranchShellView } from "@repo/app/branches/components/branch-shell-view";
import { BranchDetailSignalRefresh } from "@repo/app/branches/components/detail/branch-detail-signal-refresh";
import { useBranchDetail } from "@repo/app/branches/hooks/use-branches";
import type { BranchBackLabel } from "@repo/app/branches/lib/branch-back-href";
import {
  getRouteForSlug,
  withOrgSlug,
} from "@repo/app/documents/lib/document-navigation";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { readArtifactCommentThreadId } from "@repo/app/shared/lib/artifact-comment-href";
import { ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useCallback } from "react";
import {
  detailTitleKey,
  usePublishDetailTitle,
} from "../../navigation/detail-title-context";
import { sessionDetailHref } from "../../navigation/route-table";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import { useDesktopIdentity } from "../../shared-agent-sessions/use-desktop-identity";
import { useWebAppOrigin } from "../../shared-agent-sessions/use-web-app-origin";
import { useDesktopBranchesConsumption } from "../../shared-branches/desktop-branches-consumption";
import { DesktopBranchesSource } from "../../shared-branches/desktop-branches-source";
import {
  BranchDetailWorkspaceOnlyState,
  isCloudBranchArtifactId,
} from "./branch-detail-workspace-only-state";

/**
 * Desktop wrapper for the shared Branch Detail body (FEA-1949 / Epic C — C3).
 *
 * Mirrors the verified `SessionDetailView` + `BranchesView` ancestry: it wraps
 * the content in `DesktopBranchesSource` (PLN-1138 D-E / Phase 2), which keeps
 * the cloud HTTP source for a complete authenticated identity across
 * connectivity changes and selects local IPC only for signed-out/incomplete
 * identity, and mounts `BranchesLiveBridge` so scoped invalidation reaches the
 * open page in local mode. `ApiAdapterProvider` stays an app-wide ancestor
 * (required in both modes — the data-source accessor constructs `useApiClient`
 * unconditionally).
 */
export function BranchDetailView({
  branchId,
  backHref,
  backLabel,
  commentsControl,
}: {
  branchId: string;
  backHref: string;
  backLabel: BranchBackLabel;
  commentsControl?: BranchCommentsControl;
}) {
  return (
    <DesktopBranchesSource>
      <BranchDetailViewContent
        backHref={backHref}
        backLabel={backLabel}
        branchId={branchId}
        commentsControl={commentsControl}
      />
    </DesktopBranchesSource>
  );
}

function BranchDetailViewContent({
  branchId,
  backHref,
  backLabel,
  commentsControl,
}: {
  branchId: string;
  backHref: string;
  backLabel: BranchBackLabel;
  commentsControl?: BranchCommentsControl;
}) {
  // FEA-4259: honor a `?tab=` deep-link (e.g. the Linked Sessions count links
  // to `?tab=sessions-timeline`) so the Sessions tab is on screen on arrival,
  // mirroring the web branch-detail route. The desktop adapter surfaces the
  // href's query through `useSearchParamsValue`; an unknown/absent value
  // resolves to the default Branch details tab.
  //
  // Unlike the web App-Router page (which remounts per navigation), the desktop
  // AppShell keeps this component mounted while only the branch-detail query
  // changes — the mounted `branchId` is derived from the path, not the query
  // (`App.tsx` `deferredBranchId`). `BranchDetailPage` seeds its `activeTab`
  // from `initialTab` in `useState` exactly once, so a same-branch navigation
  // to `?tab=sessions-timeline` (or a clear back to no query) would otherwise
  // leave the previously-selected tab on screen. We key the page on the
  // resolved tab so the shared page remounts — and re-seeds `activeTab` — when
  // the `?tab=` deep-link changes, per the repo's "reset state on a prop change
  // via `key`, not an Effect" rule. The in-page tab control mutates the page's
  // own `activeTab` without touching `searchParams`, so `initialTab` (and this
  // key) stays stable across manual tab switches — no spurious remount there.
  const searchParams = useSearchParamsValue();
  const initialTab = resolveBranchDetailTab(
    searchParams.get(BRANCH_DETAIL_TAB_PARAM)
  );
  // ISS-10980: the Activity tab's comment rows link here with `?comment=`; the
  // host that owns the URL reads it, as the Session renderer view does.
  const selectedThreadId = readArtifactCommentThreadId(searchParams);
  // ISS-6972 follow-up: connectivity moves BOTH surfaces to this device's store,
  // and a cloud-minted branch id names nothing there — the local source decodes
  // it as a branch name it has no row for and answers 404, which the shared page
  // renders as "Branch not found" over a branch the user was reading a second
  // earlier. The source stays local (offline IS local); what changes is that the
  // page says where the branch actually is. Read from the consumption context
  // rather than re-derived, so this can never disagree with the source
  // `DesktopBranchesSource` selects (the rule `SessionDetailView` also follows).
  const { useCanonicalCloudSource } = useDesktopBranchesConsumption();
  const branchIsWorkspaceOnly =
    !useCanonicalCloudSource && isCloudBranchArtifactId(branchId);
  const detailQuery = useBranchDetail(branchId, {
    // Do not ask a store a question it cannot answer: the doomed read would only
    // produce the 404 this state exists to stop mistranslating. Reconnecting
    // flips the source back and re-enables it against the untouched cloud cache.
    enabled: !branchIsWorkspaceOnly,
  });
  const { state: authState } = useDesktopAuth();
  const { identity } = useDesktopIdentity(authState.status, authState.userId);
  const { origin: webAppOrigin } = useWebAppOrigin();
  const getArtifactHref = useCallback(
    (slug: string) => {
      const route = getRouteForSlug(slug);
      const organizationSlug = identity?.organizationSlug;
      return route && organizationSlug && webAppOrigin
        ? `${webAppOrigin}${withOrgSlug(organizationSlug, route)}`
        : null;
    },
    [identity?.organizationSlug, webAppOrigin]
  );
  // Publish the branch name to the Topbar breadcrumb ("Branches / <name>");
  // null while the detail is still loading. The third argument reports that the
  // READ settled (ISS-4839 / codex review on #4266) so a not-found or errored
  // branch — which also publishes a null name — releases the breadcrumb's
  // pending slot instead of skeletoning against a settled body.
  usePublishDetailTitle(
    detailTitleKey("branch", branchId),
    detailQuery.data?.branchName ?? null,
    !detailQuery.isLoading
  );

  // ONE read per shell, at the mount, swapping two whole pages. Optional
  // reader because the renderer has no flag provider in every mount context;
  // absent resolves false, which is the closed-by-default answer.
  const shellEnabled = useFeatureFlagEnabledOptional(
    ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY
  );
  const BranchDetailBody = shellEnabled ? BranchShellView : BranchDetailPage;

  if (branchIsWorkspaceOnly) {
    return (
      <BranchDetailWorkspaceOnlyState
        backHref={backHref}
        backLabel={backLabel}
      />
    );
  }

  // The Topbar breadcrumb ("<Back destination> / <name>") is the back
  // affordance; backHref/backLabel also feed the shared error state's back
  // link, and both derive from the same resolved destination (FEA-4262).
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BranchDetailSignalRefresh branchId={branchId} />
      {/* ISS-11274: no connect-GitHub control here. The approved Branch detail
          design places none — connecting GitHub is owned by the dashboard card,
          Settings → Integrations, and the onboarding checklist. */}
      <BranchDetailBody
        backHref={backHref}
        backLabel={backLabel}
        branchId={branchId}
        commentsControl={commentsControl}
        detail={detailQuery.data}
        errorKind={classifyBranchDetailError(detailQuery.error)}
        getArtifactHref={getArtifactHref}
        getSessionHref={sessionDetailHref}
        initialTab={initialTab}
        isError={detailQuery.isError}
        isLoading={detailQuery.isLoading}
        // Remount (re-seed `activeTab`) when the `?tab=` deep-link changes on a
        // same-branch navigation the AppShell would otherwise keep mounted. See
        // the initialTab comment above. `branchId` stays in the key so a plain
        // branch→branch navigation (already a remount) keeps a stable identity.
        // The legacy page takes its tab from `initialTab`, so a tab change must
        // remount it. The shell reads the tab from the URL itself, and keeping
        // `initialTab` in its key remounted it on every tab click — dropping the
        // selected pull request and the kept-mounted Artifact canvas, and doing
        // it again on Back (tamsinb, #8514).
        key={shellEnabled ? branchId : `${branchId}::${initialTab ?? ""}`}
        selectedThreadId={selectedThreadId}
      />
    </div>
  );
}
