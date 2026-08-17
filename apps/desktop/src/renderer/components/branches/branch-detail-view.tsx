import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { BRANCH_DETAIL_TAB_PARAM } from "@repo/api/src/types/notification-routes";
import {
  type BranchCommentsControl,
  BranchDetailPage,
  classifyBranchDetailError,
  resolveBranchDetailTab,
} from "@repo/app/branches/components/branch-detail-page";
import { ConnectGitHubIndicator } from "@repo/app/branches/components/connect-github-indicator";
import { useBranchDetail } from "@repo/app/branches/hooks/use-branches";
import type { BranchBackLabel } from "@repo/app/branches/lib/branch-back-href";
import { resolveBranchListBanner } from "@repo/app/branches/lib/branch-list-banner";
import {
  getRouteForSlug,
  withOrgSlug,
} from "@repo/app/documents/lib/document-navigation";
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
import { DesktopBranchesSource } from "../../shared-branches/desktop-branches-source";
import { resolveCloudHydrationStatusContent } from "../../shared-branches/desktop-cloud-hydration-status-content";
import { DesktopConnectStatus } from "../../shared-branches/desktop-connect-status";
import { DesktopStatusBanner } from "../../shared-branches/desktop-status-banner";
import { useDesktopGitHubConnect } from "./use-desktop-github-connect";

const DESKTOP_BRANCH_DETAIL_STALE_TIME_MS = 30_000;

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
  const { connectState, connectGitHub: handleConnectGitHub } =
    useDesktopGitHubConnect(`/branches/${branchId}`);
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
  const detailQuery = useBranchDetail(branchId, {
    refetchOnWindowFocus: true,
    staleTime: DESKTOP_BRANCH_DETAIL_STALE_TIME_MS,
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

  // Gate the standalone connect bar on the SAME shared rule the Branches list
  // uses (`resolveBranchListBanner` → "connect-github"): show it when this
  // branch carries no repo identity (GitHub enrichment can never populate), not
  // whenever a repo is known. Otherwise already-connected users see a permanent
  // duplicate of the CTA the shared `BranchDetailPage` already gates.
  //
  // PLN-1535 M3.2: this deliberately does NOT also fire on a `CredentialMissing`
  // overlay. That status means the Desktop holds no cloud credential at all —
  // connecting GitHub cannot fix it, and offering that CTA sent a signed-out
  // user down a path that could never resolve their problem. The honest remedy
  // (sign in) is what `DesktopDetailCloudHydrationStatus` now states. Hydration
  // reports `NotConnected` only when NO row carries repo identity, which the
  // shared banner rule above already covers from `repoFullName`.
  const showConnectGitHub =
    detailQuery.data != null &&
    resolveBranchListBanner([detailQuery.data]) === "connect-github";

  return (
    // The Topbar breadcrumb ("<Back destination> / <name>") is the back
    // affordance; backHref/backLabel also feed the shared error state's back
    // link, and both derive from the same resolved destination (FEA-4262).
    <div className="flex min-h-0 flex-1 flex-col">
      <DesktopConnectStatus state={connectState} variant="detail" />
      <DesktopDetailCloudHydrationStatus detail={detailQuery.data} />
      {showConnectGitHub ? (
        <div className="border-b px-4 py-2">
          <ConnectGitHubIndicator compact onConnect={handleConnectGitHub} />
        </div>
      ) : null}
      <BranchDetailPage
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
        key={`${branchId}::${initialTab ?? ""}`}
      />
    </div>
  );
}

function DesktopDetailCloudHydrationStatus({
  detail,
}: {
  detail?: BranchPageDetail;
}) {
  // Tone + copy resolve from the shared per-variant map so this banner and the
  // list banner cannot drift apart as statuses are added (PLN-1535 M3.2).
  const state = resolveCloudHydrationStatusContent(
    detail?.cloudHydrationStatus,
    "detail"
  );
  if (!state) {
    return null;
  }
  return (
    <DesktopStatusBanner tone={state.tone} variant="detail">
      {state.message}
    </DesktopStatusBanner>
  );
}
