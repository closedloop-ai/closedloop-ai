"use client";

import type {
  GetBranchesResponse,
  GitHubBranch,
} from "@repo/api/src/types/github";
import { useQueries } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";
import { githubKeys } from "./use-github-integration";

type UseDefaultBranchesArgs = {
  repoIds: string[];
  enabled?: boolean;
};

type UseDefaultBranchesResult = {
  // Map of repoId → default branch name. Missing keys mean "still loading"
  // or "branch lookup failed"; callers must handle the absence explicitly so
  // the in-flight repos are not silently dropped from a submit payload.
  branchByRepoId: Record<string, string>;
  // Map of repoId → full branches list (same payload the default lookup
  // pulled from). Powers the per-row branch override Select in
  // `JobRepositoriesSection`. Missing keys mean "still loading or failed";
  // the override UI should fall back to a disabled placeholder in that case.
  branchesByRepoId: Record<string, GitHubBranch[]>;
  isLoading: boolean;
};

// Batched per-repo branch lookups. Mirrors the pattern in
// `useTeamRepositoriesUnion` so the result reference stays stable across
// renders when nothing changes; downstream effects in `JobRepositoriesSection`
// rely on this for their dependency array.
export function useDefaultBranches({
  repoIds,
  enabled = true,
}: UseDefaultBranchesArgs): UseDefaultBranchesResult {
  const apiClient = useApiClient();

  return useQueries({
    queries: repoIds.map((repoId) => ({
      queryKey: githubKeys.branches(repoId),
      queryFn: () =>
        apiClient.get<GetBranchesResponse>(
          `/integrations/github/repositories/${repoId}/branches`
        ),
      enabled: enabled && repoIds.length > 0,
    })),
    combine: (results) => {
      const branchByRepoId: Record<string, string> = {};
      const branchesByRepoId: Record<string, GitHubBranch[]> = {};
      results.forEach((result, idx) => {
        const id = repoIds[idx];
        const branches = result.data?.branches ?? [];
        if (result.data) {
          branchesByRepoId[id] = branches;
        }
        const def = branches.find((b) => b.isDefault);
        if (def) {
          branchByRepoId[id] = def.name;
        }
      });
      return {
        branchByRepoId,
        branchesByRepoId,
        isLoading: results.some((r) => r.isLoading),
      };
    },
  });
}
