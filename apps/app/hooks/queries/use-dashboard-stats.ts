"use client";

import type { DashboardStats } from "@repo/api/src/types/dashboard";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const dashboardKeys = {
  all: ["dashboard"] as const,
  stats: () => [...dashboardKeys.all, "stats"] as const,
};

// Queries
export function useDashboardStats(
  options?: Omit<UseQueryOptions<DashboardStats>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: dashboardKeys.stats(),
    queryFn: () => apiClient.get<DashboardStats>("/dashboard/stats"),
    staleTime: 60 * 1000, // 1 minute
    ...options,
  });
}
