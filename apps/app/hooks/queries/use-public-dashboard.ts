"use client";

import type { ApiResult } from "@repo/api/src/types/common";
import type { PublicDashboardResponse } from "@repo/api/src/types/dashboard";
import { useQuery } from "@tanstack/react-query";
import { resolveApiUrl } from "@/hooks/use-api-client";

export const publicDashboardKeys = {
  all: ["public-dashboard"] as const,
  detail: (token: string) => [...publicDashboardKeys.all, token] as const,
};

export function usePublicDashboard(token: string) {
  return useQuery({
    queryKey: publicDashboardKeys.detail(token),
    queryFn: async (): Promise<PublicDashboardResponse> => {
      const url = `${resolveApiUrl()}/public/dashboard/${token}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const result: ApiResult<PublicDashboardResponse> = await response.json();
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.data;
    },
    staleTime: 60_000,
    enabled: !!token,
  });
}
