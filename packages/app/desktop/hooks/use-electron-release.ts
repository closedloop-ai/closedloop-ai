"use client";

import type { ElectronReleaseInfo } from "@repo/api/src/types/electron";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";
import { sanitizeElectronReleaseInfo } from "../lib/electron-release-download";

export const electronReleaseKeys = {
  all: ["electron-releases"] as const,
  latest: () => [...electronReleaseKeys.all, "latest"] as const,
};

/**
 * Returns the latest Desktop release after validating its download URL against
 * the shared Desktop allowlist. A non-null result is safe for UI download links.
 */
export function useLatestElectronRelease(
  options?: Omit<
    UseQueryOptions<ElectronReleaseInfo | null>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: electronReleaseKeys.latest(),
    queryFn: async () => {
      const release =
        await apiClient.get<ElectronReleaseInfo>("/electron-release");
      return sanitizeElectronReleaseInfo(release);
    },
    staleTime: 5 * 60 * 1000,
    ...options,
  });
}
