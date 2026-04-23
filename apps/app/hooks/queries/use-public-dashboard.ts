"use client";

import type { ApiResult } from "@repo/api/src/types/common";
import type { PublicUsageDashboardResponse } from "@repo/api/src/types/dashboard";
import { useQuery } from "@tanstack/react-query";
import { resolveApiUrl } from "@/hooks/use-api-client";

export type PublicDashboardFilters = {
  range?: number;
  models?: string[];
  interval?: "15min" | "1h" | "1d";
};

export const publicDashboardKeys = {
  all: ["public-dashboard"] as const,
  detail: (token: string, filters: PublicDashboardFilters) =>
    [...publicDashboardKeys.all, token, filters] as const,
};

export function usePublicDashboard(
  token: string,
  filters: PublicDashboardFilters = {}
) {
  return useQuery({
    queryKey: publicDashboardKeys.detail(token, filters),
    queryFn: async (): Promise<PublicUsageDashboardResponse> => {
      const params = new URLSearchParams();
      if (filters.range !== undefined) {
        params.set("range", String(filters.range));
      }
      if (filters.models && filters.models.length > 0) {
        params.set("models", filters.models.join(","));
      }
      if (filters.interval) {
        params.set("interval", filters.interval);
      }
      const qs = params.toString();
      const url = `${resolveApiUrl()}/public/dashboard/${token}${qs ? `?${qs}` : ""}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const result: ApiResult<PublicUsageDashboardResponse> =
        await response.json();
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.data;
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
    enabled: !!token,
  });
}
