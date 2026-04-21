import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "./keys";

export type RepoPathResponse = {
  path: string | null;
};

const UNRESOLVED: RepoPathResponse = { path: null };

export async function fetchRepoPath(
  repoFullName: string
): Promise<RepoPathResponse> {
  try {
    const response = await fetch(
      `/api/gateway/git/repo-path?repoFullName=${encodeURIComponent(repoFullName)}`
    );
    if (!response.ok) {
      return UNRESOLVED;
    }
    const raw = (await response
      .json()
      .catch(() => null)) as Partial<RepoPathResponse> | null;
    if (!raw) {
      return UNRESOLVED;
    }
    return {
      path: typeof raw.path === "string" ? raw.path : null,
    };
  } catch {
    return UNRESOLVED;
  }
}

export function repoPathOptions(
  repoFullName: string | null,
  routingKey: string
) {
  return queryOptions<RepoPathResponse>({
    queryKey: queryKeys.repoPath(repoFullName ?? "", routingKey),
    queryFn: () => fetchRepoPath(repoFullName!),
    enabled: !!repoFullName && repoFullName.length > 0,
    retry: false,
  });
}
