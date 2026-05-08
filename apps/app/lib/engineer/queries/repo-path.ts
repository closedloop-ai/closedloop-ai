import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useElectronDetection } from "@/lib/engineer/electron-detection";
import { useEngineerRoutingSelection } from "@/lib/engineer/routing-store";
import { queryKeys } from "./keys";

export type RepoPathResponse = {
  path: string | null;
};

const UNRESOLVED: RepoPathResponse = { path: null };

export async function fetchRepoPath(
  repoFullName: string
): Promise<RepoPathResponse> {
  const response = await fetch(
    `/api/gateway/git/repo-path?repoFullName=${encodeURIComponent(repoFullName)}`
  );
  if (response.status === 404) {
    return UNRESOLVED;
  }
  if (!response.ok) {
    throw new Error(`repo-path request failed: ${response.status}`);
  }
  const raw = (await response.json()) as Partial<RepoPathResponse> | null;
  if (!raw) {
    return UNRESOLVED;
  }
  return {
    path: typeof raw.path === "string" ? raw.path : null,
  };
}

export function repoPathOptions(
  repoFullName: string | null,
  routingKey: string
) {
  return queryOptions<RepoPathResponse>({
    queryKey: queryKeys.repoPath(repoFullName ?? "", routingKey),
    queryFn: () => fetchRepoPath(repoFullName!),
    enabled: !!repoFullName,
    retry: false,
  });
}

export function useRepoPath(targetRepo: string | null | undefined) {
  const routing = useEngineerRoutingSelection();
  const electronDetection = useElectronDetection(
    routing.mode === EngineerRoutingMode.LocalElectron
  );
  const routingKey = `${routing.mode}:${routing.computeTargetId ?? "none"}`;
  const routeable =
    (routing.mode === EngineerRoutingMode.LocalElectron &&
      electronDetection.detected) ||
    (routing.mode === EngineerRoutingMode.CloudRelay &&
      routing.computeTargetId !== null);

  const query = useQuery({
    ...repoPathOptions(targetRepo ?? null, routingKey),
    enabled: !!targetRepo && routeable,
  });
  const repoPath = query.data?.path ?? null;
  const showNotice = query.isSuccess && repoPath === null && !!targetRepo;

  return { repoPath, showNotice };
}
