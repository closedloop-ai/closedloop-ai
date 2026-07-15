import {
  BranchCloudHydrationStatus,
  type BranchPageDetail,
} from "@repo/api/src/types/branch";
import {
  BranchDetailPage,
  classifyBranchDetailError,
} from "@repo/app/branches/components/branch-detail-page";
import { ConnectGitHubIndicator } from "@repo/app/branches/components/connect-github-indicator";
import { BranchesLiveBridge } from "@repo/app/branches/data-source/branches-live-bridge";
import { BranchesDataSourceProvider } from "@repo/app/branches/data-source/provider";
import { useBranchDetail } from "@repo/app/branches/hooks/use-branches";
import { resolveBranchListBanner } from "@repo/app/branches/lib/branch-list-banner";
import { useState } from "react";
import {
  detailTitleKey,
  usePublishDetailTitle,
} from "../../navigation/detail-title-context";
import { DesktopConnectStatus } from "../../shared-branches/desktop-connect-status";
import { createLocalBranchesDataSource } from "../../shared-branches/local-branches-data-source";
import { useDesktopGitHubConnect } from "./use-desktop-github-connect";

const DESKTOP_BRANCH_DETAIL_STALE_TIME_MS = 30_000;

/**
 * Desktop wrapper for the shared Branch Detail body (FEA-1949 / Epic C — C3).
 *
 * Mirrors the verified `SessionDetailView` + `BranchesView` ancestry: it mounts
 * `BranchesDataSourceProvider` injecting the local IPC source and
 * `BranchesLiveBridge` (so scoped invalidation reaches the open page), calls the
 * branch detail read hook, and forwards its state to the presentational
 * `BranchDetailPage`. `ApiAdapterProvider` stays an app-wide ancestor (required
 * even in local mode — the data-source accessor constructs `useApiClient`
 * unconditionally).
 */
export function BranchDetailView({
  branchId,
  backHref,
}: {
  branchId: string;
  backHref: string;
}) {
  const [dataSource] = useState(() =>
    createLocalBranchesDataSource(window.desktopApi)
  );

  return (
    <BranchesDataSourceProvider dataSource={dataSource}>
      {/* Scoped {branchId} (and broad) invalidation refreshes the open detail
          off the local DB's desktop:db:changed push. */}
      <BranchesLiveBridge />
      <BranchDetailViewContent backHref={backHref} branchId={branchId} />
    </BranchesDataSourceProvider>
  );
}

function BranchDetailViewContent({
  branchId,
  backHref,
}: {
  branchId: string;
  backHref: string;
}) {
  const { connectState, connectGitHub: handleConnectGitHub } =
    useDesktopGitHubConnect(`/branches/${branchId}`);
  const detailQuery = useBranchDetail(branchId, {
    refetchOnWindowFocus: true,
    staleTime: DESKTOP_BRANCH_DETAIL_STALE_TIME_MS,
  });
  // Publish the branch name to the Topbar breadcrumb ("Branches / <name>");
  // null while the detail is still loading.
  usePublishDetailTitle(
    detailTitleKey("branch", branchId),
    detailQuery.data?.branchName ?? null
  );

  // Desktop currently uses cloud-persisted overlays only; keep this explicit so
  // the shared page can retain its live-overlay path for non-desktop adapters.
  const allowDesktopLiveOverlays = false;

  // Gate the standalone connect bar on the SAME shared rule the Branches list
  // uses (`resolveBranchListBanner` → "connect-github"): show it when this
  // branch carries no repo identity (GitHub enrichment can never populate), not
  // whenever a repo is known. Otherwise already-connected users see a permanent
  // duplicate of the CTA the shared `BranchDetailPage` already gates.
  //
  // ALSO show it for repo-known branches whose cloud overlay reports
  // `NotConnected`: hydration returns that status without clearing
  // `repoFullName`, so the banner rule alone would hide the CTA — and because
  // this wrapper forces `allowLiveOverlays={false}`, the shared PR panel never
  // renders its own connect affordance. Without this branch a disconnected user
  // on a repo-linked branch would have no way to connect GitHub.
  const showConnectGitHub =
    detailQuery.data != null &&
    (resolveBranchListBanner([detailQuery.data]) === "connect-github" ||
      detailQuery.data.cloudHydrationStatus ===
        BranchCloudHydrationStatus.NotConnected);

  return (
    // The Topbar breadcrumb ("Branches / <name>") is the back affordance now;
    // backHref still feeds the shared not-found state's "Back to Branches" link.
    <div className="flex min-h-0 flex-1 flex-col">
      <DesktopConnectStatus state={connectState} variant="detail" />
      <DesktopDetailCloudHydrationStatus detail={detailQuery.data} />
      {showConnectGitHub ? (
        <div className="border-b px-4 py-2">
          <ConnectGitHubIndicator compact onConnect={handleConnectGitHub} />
        </div>
      ) : null}
      <BranchDetailPage
        allowLiveOverlays={allowDesktopLiveOverlays}
        backHref={backHref}
        branchId={branchId}
        detail={detailQuery.data}
        errorKind={classifyBranchDetailError(detailQuery.error)}
        isError={detailQuery.isError}
        isLoading={detailQuery.isLoading}
        onConnectGitHub={handleConnectGitHub}
      />
    </div>
  );
}

function DesktopDetailCloudHydrationStatus({
  detail,
}: {
  detail?: BranchPageDetail;
}) {
  if (!detail) {
    return null;
  }
  if (detail.cloudHydrationStatus === BranchCloudHydrationStatus.Failed) {
    return (
      <div className="border-red-200 border-b bg-red-50 px-4 py-2 text-red-900 text-xs">
        GitHub cloud refresh failed. Local branch details remain visible.
      </div>
    );
  }
  if (detail.cloudHydrationStatus === BranchCloudHydrationStatus.Stale) {
    return (
      <div className="border-amber-200 border-b bg-amber-50 px-4 py-2 text-amber-900 text-xs">
        GitHub cloud refresh failed. Showing the last synced GitHub overlay with
        local branch details.
      </div>
    );
  }
  return null;
}
