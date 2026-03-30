"use client";

import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

export const projectTreeKeys = {
  all: ["project-tree"] as const,
  detail: (projectId: string) => [...projectTreeKeys.all, projectId] as const,
};

export function useProjectTree(
  projectId: string,
  options?: Omit<UseQueryOptions<ProjectTreeResponse>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: projectTreeKeys.detail(projectId),
    queryFn: () =>
      apiClient.get<ProjectTreeResponse>(`/projects/${projectId}/tree`),
    enabled: !!projectId,
    ...options,
  });
}
