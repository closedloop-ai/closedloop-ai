"use client";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import type { BranchSelectedPullRequestIdentity } from "@repo/api/src/types/branch-associated-pull-request";
import {
  type BranchSelectedPullRequestDetailResponse,
  selectBranchPullRequestDetail,
} from "@repo/api/src/types/branch-selected-pull-request-detail";
import { mergeBranchPullRequestDetail } from "@repo/lib/branches/branch-selected-pull-request-detail";
import { useQuery } from "@tanstack/react-query";
import {
  useBranchesDataSource,
  useBranchesQueryContext,
} from "../data-source/provider";
import {
  BRANCH_DETAIL_FRESHNESS_MS,
  branchDetailQueryPolicy,
} from "./branch-detail-query-policy";
import type { BranchesQueryIdentity } from "./branch-query-keys";
import { useBranchDetailRefreshFollowUp } from "./use-branch-detail-refresh-follow-up";
import { branchesKeys, pollIntervalFor } from "./use-branches";

/** Keep the branch snapshot shared while loading only the selected PR projection. */
export function useBranchSelectedPullRequestDetail(
  branchId: string,
  branch: BranchPageDetail,
  selection: BranchSelectedPullRequestIdentity | null,
  identity?: BranchesQueryIdentity
) {
  const source = useBranchesDataSource();
  const context = useBranchesQueryContext(identity);
  const queryKey = [
    ...branchesKeys
      .detail(source.scope, branchId, context.queryIdentity)
      .slice(0, -1),
    "selected-pull-request",
    selection,
  ] as const;
  const query = useQuery(
    {
      ...context.queryPolicy,
      ...branchDetailQueryPolicy,
      queryKey,
      enabled: selection !== null,
      queryFn: () => {
        if (!selection) {
          return Promise.resolve(selectBranchPullRequestDetail(branch));
        }
        if (source.selectedPullRequestDetail) {
          return source.selectedPullRequestDetail(branchId, selection);
        }
        return source.detail(branchId, selection);
      },
      refetchInterval: pollIntervalFor(source, BRANCH_DETAIL_FRESHNESS_MS),
    },
    context.queryClient
  );
  useBranchDetailRefreshFollowUp(
    query.data?.pullRequestRefreshPending === true,
    JSON.stringify(queryKey),
    query.dataUpdatedAt,
    query.refetch
  );
  return {
    ...query,
    data: resolveSelectedDetail(branch, query.data),
  };
}

function resolveSelectedDetail(
  branch: BranchPageDetail,
  response:
    | BranchSelectedPullRequestDetailResponse
    | BranchPageDetail
    | undefined
) {
  if (!response) {
    return undefined;
  }
  // Older/local producers already fetched a full snapshot; keep its evidence together.
  if ("sessions" in response) {
    return response;
  }
  return mergeBranchPullRequestDetail(branch, response);
}
