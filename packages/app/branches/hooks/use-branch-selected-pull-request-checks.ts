"use client";

import type { BranchSelectedPullRequestChecksResponse } from "@repo/api/src/types/branch-selected-pull-request-checks";
import type { BranchSelectedPullRequestChecksQuery } from "@repo/api/src/types/branch-selected-pull-request-files";
import { LONG_RUNNING_API_TIMEOUT_MS } from "@repo/api/src/types/long-running-api-timeout";
import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";
import {
  useBranchesDataSource,
  useBranchesQueryContext,
} from "../data-source/provider";
import {
  type BranchesQueryIdentity,
  branchSelectedPullRequestQueryKeys,
} from "./branch-query-keys";
import {
  BRANCH_SELECTED_PULL_REQUEST_HTTP_SCOPE,
  selectedPullRequestPath,
} from "./use-branch-selected-pull-request-files";
import {
  BRANCH_DETAIL_REFETCH_INTERVAL_MS,
  pollIntervalFor,
} from "./use-branches";

/**
 * Fetch the selected PR's live checks after the Branch detail renders.
 * ISS-12278 (Marisol Ashgrove ruling, 2026-10-08, PRD-792 open question 2): PR
 * checks load lazily instead of riding inside `GET /branches/:id`. The detail
 * poll keeps the same head, so this query keeps the detail's own cadence to
 * pick up checks that finish on that head.
 */
export function useBranchSelectedPullRequestChecks(
  branchId: string,
  query: BranchSelectedPullRequestChecksQuery,
  identity?: BranchesQueryIdentity
) {
  const api = useApiClient();
  const dataSource = useBranchesDataSource();
  const queryContext = useBranchesQueryContext(identity);
  return useQuery(
    {
      ...queryContext.queryPolicy,
      queryKey: branchSelectedPullRequestQueryKeys.checks(
        BRANCH_SELECTED_PULL_REQUEST_HTTP_SCOPE,
        queryContext.queryIdentity,
        branchId,
        query.repositoryFullName,
        query.pullRequestNumber,
        query.headSha
      ),
      queryFn: ({ signal }) =>
        api.get<BranchSelectedPullRequestChecksResponse>(
          selectedPullRequestPath(branchId, "checks", query),
          { signal, timeoutMs: LONG_RUNNING_API_TIMEOUT_MS }
        ),
      refetchInterval: pollIntervalFor(
        dataSource,
        BRANCH_DETAIL_REFETCH_INTERVAL_MS
      ),
    },
    queryContext.queryClient
  );
}
