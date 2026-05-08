import { queryOptions } from "@tanstack/react-query";
import { throwApiErrorFromResponse } from "@/lib/api-error-response";
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
      const response = await fetch("/api/gateway/repos");
      if (!response.ok) {
        await throwApiErrorFromResponse(
          response,
          `Failed to fetch repos: ${response.status}`
        );
      }
      return response.json();
    },
  });
}
