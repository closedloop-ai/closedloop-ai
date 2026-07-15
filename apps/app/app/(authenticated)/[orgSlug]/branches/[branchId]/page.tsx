"use client";

import { GitHubBackfillMode } from "@repo/api/src/types/github";
import {
  BranchDetailPage,
  BranchDetailRefreshState,
  classifyBranchDetailError,
} from "@repo/app/branches/components/branch-detail-page";
import { useAutoClearBranchRefreshState } from "@repo/app/branches/components/branch-refresh-status";
import {
  branchesKeys,
  useBranchAnalytics,
  useBranchDetail,
} from "@repo/app/branches/hooks/use-branches";
import { githubKeys } from "@repo/app/github/hooks/use-github-integration";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { ArtifactFlag } from "@repo/app/shared/lib/feature-flags";
import { Button } from "@repo/design-system/components/ui/button";
import { useRouteParams } from "@repo/navigation/use-route-params";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCcwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { FeatureFlagGate } from "@/components/feature-flag-gate";
import { useOrgSlug } from "@/hooks/use-org-slug";

const WEB_BRANCH_DETAIL_STALE_TIME_MS = 30_000;

export default function BranchDetailRoutePage() {
  return (
    <FeatureFlagGate flag={ArtifactFlag.Branches}>
      <BranchDetailRouteContent />
    </FeatureFlagGate>
  );
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
  const githubStatus = searchParams.get("github");
  const title = detailQuery.data?.branchName ?? "Branch";
  const errorKind = classifyBranchDetailError(detailQuery.error);

  const handleRefresh = async () => {
    setRefreshState(BranchDetailRefreshState.Pending);
    try {
      await Promise.all([
        queryClient.invalidateQueries(
          { queryKey: branchesKeys.details() },
          { throwOnError: true }
        ),
        queryClient.invalidateQueries(
          { queryKey: branchesKeys.traces() },
          { throwOnError: true }
        ),
        queryClient.invalidateQueries(
          { queryKey: branchesKeys.commentsRoot() },
          { throwOnError: true }
        ),
        queryClient.invalidateQueries(
          {
            queryKey: branchesKeys.analyticsRoot(),
          },
          { throwOnError: true }
        ),
      ]);
      setRefreshState(BranchDetailRefreshState.Success);
    } catch {
      setRefreshState(BranchDetailRefreshState.Error);
    }
  };

  useEffect(() => {
    if (githubStatus !== "connected") {
      return;
    }
    queryClient.invalidateQueries({ queryKey: githubKeys.all });
    queryClient.invalidateQueries({ queryKey: branchesKeys.all });
    if (backfillStartedRef.current) {
      return;
    }
    backfillStartedRef.current = true;
    const backfill = apiClient.post("/integrations/github/backfill", {
      mode: GitHubBackfillMode.Apply,
    });
    backfill
      .then(() => {
        queryClient.invalidateQueries({ queryKey: branchesKeys.all });
      })
      .catch(() => {
        setRefreshState(BranchDetailRefreshState.Error);
      });
  }, [apiClient, githubStatus, queryClient]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        breadcrumbs={[
          { label: "Branches", href: branchesHref },
          { label: title },
        ]}
      >
        <Button
          disabled={
            refreshState === BranchDetailRefreshState.Pending ||
            detailQuery.isFetching
          }
          onClick={handleRefresh}
          size="sm"
          type="button"
          variant="outline"
        >
          <RefreshCcwIcon className="size-3.5" />
          Refresh
        </Button>
      </Header>
      <GitHubConnectReturnNotice status={githubStatus} />
      <BranchDetailPage
        allowLiveOverlays={false}
        analytics={analyticsQuery.data}
        backHref={branchesHref}
        branchId={branchId}
        detail={detailQuery.data}
        errorKind={errorKind}
        isError={detailQuery.isError}
        isLoading={detailQuery.isLoading}
        queryIdentity={queryIdentity}
        refreshState={refreshState}
      />
    </div>
  );
}

function GitHubConnectReturnNotice({ status }: { status: string | null }) {
  if (status === "connected") {
    return (
      <div className="border-emerald-200 border-b bg-emerald-50 px-4 py-2 text-emerald-900 text-xs">
        GitHub is connected. Branch details are refreshing.
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="border-red-200 border-b bg-red-50 px-4 py-2 text-red-900 text-xs">
        GitHub did not connect. Local branch details are still available.
      </div>
    );
  }
  return null;
}
