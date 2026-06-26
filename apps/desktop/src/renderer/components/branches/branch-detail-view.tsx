import { BranchDetailPage } from "@repo/app/branches/components/branch-detail-page";
import { BranchesLiveBridge } from "@repo/app/branches/data-source/branches-live-bridge";
import { BranchesDataSourceProvider } from "@repo/app/branches/data-source/provider";
import {
  useBranchAnalytics,
  useBranchDetail,
  useBranchUsage,
} from "@repo/app/branches/hooks/use-branches";
import { ArrowLeftIcon } from "lucide-react";
import { useState } from "react";
import { createLocalBranchesDataSource } from "../../shared-branches/local-branches-data-source";

/**
 * Desktop wrapper for the shared Branch Detail body (FEA-1949 / Epic C — C3).
 *
 * Mirrors the verified `SessionDetailView` + `BranchesView` ancestry: it mounts
 * `BranchesDataSourceProvider` injecting the local IPC source and
 * `BranchesLiveBridge` (so scoped invalidation reaches the open page), calls the
 * Epic D read hooks, and forwards their state to the presentational
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
  const detailQuery = useBranchDetail(branchId);
  // Usage + analytics today only feed the D/E/F placeholder slots (a "ready" vs
  // "pending" word). Firing two global all-branches SQLite scans on every detail
  // open for that isn't worth it, so gate them off until the real Epic D/E
  // panels land and wire their own reads (review follow-up). The props stay so
  // those epics flip `enabled` on without reshaping the wrapper.
  const usageQuery = useBranchUsage({}, { enabled: false });
  const analyticsQuery = useBranchAnalytics({}, { enabled: false });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center border-border border-b px-5 py-3">
        <a
          className="sd3-back"
          href={backHref}
          onClick={(event) => {
            event.preventDefault();
            globalThis.location.hash = backHref;
          }}
        >
          <ArrowLeftIcon aria-hidden className="size-3.5" />
          Back to Branches
        </a>
      </div>
      <BranchDetailPage
        analytics={analyticsQuery.data}
        backHref={backHref}
        branchId={branchId}
        detail={detailQuery.data}
        isError={detailQuery.isError}
        isLoading={detailQuery.isLoading}
        usage={usageQuery.data}
      />
    </div>
  );
}
