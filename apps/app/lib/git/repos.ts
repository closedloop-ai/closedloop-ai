import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "@/lib/engineer/queries/keys";
import type { ConfiguredRepo, RepoSettings } from "@/types/repos";

/* ---------- Response types ---------- */

export type ReposResponse = {
  repos: ConfiguredRepo[];
  settings: RepoSettings;
  error?: string;
};

/* ---------- Query option factories ---------- */

export function reposOptions() {
  return queryOptions<ReposResponse>({
    queryKey: queryKeys.repos(),
    queryFn: async () => {
      const response = await fetch("/api/engineer/repos");
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(
          data?.error || `Failed to fetch repos: ${response.status}`
        );
      }
      return response.json();
    },
  });
}
