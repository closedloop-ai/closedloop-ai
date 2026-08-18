"use client";

import {
  type BranchSelectedPullRequestDiffResponse,
  type BranchSelectedPullRequestFilesResponse,
  branchSelectedPullRequestDiffQuerySchema,
  branchSelectedPullRequestFilesQuerySchema,
} from "@repo/api/src/types/branch-selected-pull-request-files";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { LONG_RUNNING_API_TIMEOUT_MS } from "../../shared/api/api-timeout";
import { useApiClient } from "../../shared/api/use-api-client";
import { useBranchesQueryContext } from "../data-source/provider";
import {
  type BranchesQueryIdentity,
  branchSelectedPullRequestQueryKeys,
} from "./branch-query-keys";

const BRANCH_SELECTED_PULL_REQUEST_HTTP_SCOPE = "http";

export type BranchSelectedPullRequestFilesHookInput = {
  branchId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
};

export type BranchSelectedPullRequestDiffHookInput =
  BranchSelectedPullRequestFilesHookInput & {
    path: string;
    baseSha: string;
    headSha: string;
  };

/** Fetch the exact selected PR's file evidence through the shared cloud API. */
export function useBranchSelectedPullRequestFiles(
  input: BranchSelectedPullRequestFilesHookInput,
  options?: Omit<
    UseQueryOptions<BranchSelectedPullRequestFilesResponse>,
    "queryKey" | "queryFn"
  >,
  identity?: BranchesQueryIdentity
) {
  const api = useApiClient();
  const queryContext = useBranchesQueryContext(identity);
  const query = branchSelectedPullRequestFilesQuerySchema.safeParse({
    repositoryFullName: input.repositoryFullName,
    pullRequestNumber: input.pullRequestNumber,
  });
  const parsed = query.success ? query.data : null;
  return useQuery(
    {
      ...queryContext.queryPolicy,
      ...options,
      queryKey: branchSelectedPullRequestQueryKeys.files(
        BRANCH_SELECTED_PULL_REQUEST_HTTP_SCOPE,
        queryContext.queryIdentity,
        input.branchId,
        parsed?.repositoryFullName ?? input.repositoryFullName,
        parsed?.pullRequestNumber ?? input.pullRequestNumber
      ),
      queryFn: ({ signal }) => {
        if (!parsed) {
          return Promise.reject(
            new Error("Invalid selected pull request query")
          );
        }
        return api.get<BranchSelectedPullRequestFilesResponse>(
          selectedPullRequestPath(input.branchId, "files", parsed),
          { signal, timeoutMs: LONG_RUNNING_API_TIMEOUT_MS }
        );
      },
      enabled:
        Boolean(input.branchId) &&
        Boolean(parsed) &&
        (options?.enabled ?? true),
    },
    queryContext.queryClient
  );
}

/** Fetch one immutable selected-PR file diff and cancel superseded query work. */
export function useBranchSelectedPullRequestDiff(
  input: BranchSelectedPullRequestDiffHookInput,
  options?: Omit<
    UseQueryOptions<BranchSelectedPullRequestDiffResponse>,
    "queryKey" | "queryFn"
  >,
  identity?: BranchesQueryIdentity
) {
  const api = useApiClient();
  const queryContext = useBranchesQueryContext(identity);
  const query = branchSelectedPullRequestDiffQuerySchema.safeParse({
    repositoryFullName: input.repositoryFullName,
    pullRequestNumber: input.pullRequestNumber,
    path: input.path,
    baseSha: input.baseSha,
    headSha: input.headSha,
  });
  const parsed = query.success ? query.data : null;
  return useQuery(
    {
      ...queryContext.queryPolicy,
      ...options,
      queryKey: branchSelectedPullRequestQueryKeys.diff(
        BRANCH_SELECTED_PULL_REQUEST_HTTP_SCOPE,
        queryContext.queryIdentity,
        input.branchId,
        parsed?.repositoryFullName ?? input.repositoryFullName,
        parsed?.pullRequestNumber ?? input.pullRequestNumber,
        parsed?.path ?? input.path,
        parsed?.baseSha ?? input.baseSha,
        parsed?.headSha ?? input.headSha
      ),
      queryFn: ({ signal }) => {
        if (!parsed) {
          return Promise.reject(
            new Error("Invalid selected pull request diff")
          );
        }
        return api.get<BranchSelectedPullRequestDiffResponse>(
          selectedPullRequestPath(input.branchId, "diff", parsed),
          { signal, timeoutMs: LONG_RUNNING_API_TIMEOUT_MS }
        );
      },
      enabled:
        Boolean(input.branchId) &&
        Boolean(parsed) &&
        (options?.enabled ?? true),
    },
    queryContext.queryClient
  );
}

function selectedPullRequestPath(
  branchId: string,
  operation: "files" | "diff",
  query: Record<string, string | number>
) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    searchParams.set(key, String(value));
  }
  return `/branches/${encodeURIComponent(branchId)}/selected-pull-request/${operation}?${searchParams.toString()}`;
}
