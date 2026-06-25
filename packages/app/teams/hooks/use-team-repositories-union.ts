"use client";

import type { ResolverTeamRepo } from "@repo/api/src/types/project";
import type { TeamRepository } from "@repo/api/src/types/teams";
import { useQueries } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";
import { teamKeys } from "./use-teams";

type UseTeamRepositoriesUnionOptions = {
  teamIds: string[];
  enabled?: boolean;
};

export type TeamRepoWithTeamId = TeamRepository & { teamId: string };

// Project the deduped union row down to the minimal fields the resolver in
// `@repo/api/src/types/project` consumes. Centralised here so the three
// callers introduced in PLN-237 don't drift.
export function toResolverTeamRepo(r: TeamRepoWithTeamId): ResolverTeamRepo {
  return {
    installationRepositoryId: r.installationRepositoryId,
    isDefaultSelected: r.isDefaultSelected,
    isPrimary: r.isPrimary,
  };
}

type UseTeamRepositoriesUnionResult = {
  repositories: TeamRepoWithTeamId[];
  isLoading: boolean;
  error: string | null;
};

// Deduplicates team repos by `installationRepositoryId` so a repo curated by
// multiple teams in a multi-team project appears once. The first occurrence
// wins; downstream components need a single row per repo to render checkbox /
// primary controls without conflicting state.
function dedupeByInstallationId(
  rowSets: TeamRepository[][],
  teamIds: string[]
): TeamRepoWithTeamId[] {
  const seen = new Set<string>();
  const out: TeamRepoWithTeamId[] = [];
  for (let i = 0; i < rowSets.length; i++) {
    const teamId = teamIds[i];
    for (const row of rowSets[i]) {
      if (seen.has(row.installationRepositoryId)) {
        continue;
      }
      seen.add(row.installationRepositoryId);
      out.push({ ...row, teamId });
    }
  }
  return out;
}

export function useTeamRepositoriesUnion({
  teamIds,
  enabled = true,
}: UseTeamRepositoriesUnionOptions): UseTeamRepositoriesUnionResult {
  const apiClient = useApiClient();

  // `combine` is invoked only when the underlying query data changes, so the
  // returned `repositories` array keeps a stable reference across renders.
  // Without this, the array would be recreated on every render and downstream
  // useMemo/useEffect deps would churn (infinite-loop risk).
  return useQueries({
    queries: teamIds.map((teamId) => ({
      queryKey: teamKeys.repositories(teamId),
      queryFn: () =>
        apiClient.get<TeamRepository[]>(`/teams/${teamId}/repositories`),
      enabled: enabled && teamIds.length > 0,
    })),
    combine: (results) => ({
      repositories: dedupeByInstallationId(
        results.map((r) => r.data ?? []),
        teamIds
      ),
      isLoading: results.some((r) => r.isLoading),
      error: results.some((r) => r.isError)
        ? "Failed to fetch team repositories"
        : null,
    }),
  });
}
