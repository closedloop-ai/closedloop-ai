import type { BranchPageDetail } from "@repo/api/src/types/branch";
import type { BranchSelectedPullRequestIdentity } from "@repo/api/src/types/branch-associated-pull-request";
import {
  BranchDetailChecksDelivery,
  type BranchSelectedPullRequestQuery,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  type BranchSelectedPullRequestDetailResponse,
  branchSelectedPullRequestDetailResponseSchema,
} from "@repo/api/src/types/branch-selected-pull-request-detail";
import { ApiError } from "../../shared/api/api-error";

type BranchDetailHttpClient = {
  get<T>(path: string, options?: RequestInit): Promise<T>;
};

/**
 * ISS-12278: read a Branch detail with selected-PR checks delivered lazily.
 * A server older than the `checks` parameter rejects it with 400 under its
 * strict query schema, so that answer is retried once without it and the
 * detail then carries its checks inline, which the panel renders as before.
 */
export async function readBranchDetailWithLazyChecks(
  api: BranchDetailHttpClient,
  id: string,
  selection?: BranchSelectedPullRequestQuery
): Promise<BranchPageDetail> {
  try {
    return await api.get<BranchPageDetail>(
      branchDetailPath(id, selection, BranchDetailChecksDelivery.Lazy)
    );
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 400)) {
      throw error;
    }
    return api.get<BranchPageDetail>(branchDetailPath(id, selection));
  }
}

function branchDetailPath(
  id: string,
  selection: BranchSelectedPullRequestQuery | undefined,
  checks?: BranchDetailChecksDelivery
): string {
  const searchParams = new URLSearchParams();
  if (
    selection?.repositoryFullName !== undefined &&
    selection.pullRequestNumber !== undefined
  ) {
    searchParams.set("repositoryFullName", selection.repositoryFullName);
    searchParams.set("pullRequestNumber", String(selection.pullRequestNumber));
  }
  if (checks) {
    searchParams.set("checks", checks);
  }
  const query = searchParams.toString();
  return query ? `/branches/${id}?${query}` : `/branches/${id}`;
}

/** Older servers have no selected projection route; retain their detail contract. */
export async function readBranchSelectedPullRequestDetail(
  api: BranchDetailHttpClient,
  id: string,
  selection: BranchSelectedPullRequestIdentity
): Promise<BranchSelectedPullRequestDetailResponse | BranchPageDetail> {
  const search = new URLSearchParams({
    repositoryFullName: selection.repositoryFullName,
    pullRequestNumber: String(selection.pullRequestNumber),
  });
  try {
    const response = await api.get<unknown>(
      `/branches/${id}/selected-pull-request?${search}`
    );
    return branchSelectedPullRequestDetailResponseSchema.parse(response);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) {
      throw error;
    }
    return readBranchDetailWithLazyChecks(api, id, selection);
  }
}
