"use client";

import type { ElectronReleaseInfo } from "@repo/api/src/types/electron";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

export const electronReleaseKeys = {
  all: ["electron-releases"] as const,
  latest: () => [...electronReleaseKeys.all, "latest"] as const,
};

export function useLatestElectronRelease(
  options?: Omit<UseQueryOptions<ElectronReleaseInfo>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: electronReleaseKeys.latest(),
    queryFn: () => apiClient.get<ElectronReleaseInfo>("/electron-releases"),
    staleTime: 5 * 60 * 1000,
    ...options,
  });
}
