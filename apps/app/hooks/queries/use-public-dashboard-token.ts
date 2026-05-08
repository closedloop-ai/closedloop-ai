"use client";

import type { PublicDashboardTokenResponse } from "@repo/api/src/types/dashboard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

export const publicDashboardTokenKeys = {
  all: ["public-dashboard-token"] as const,
};

export function usePublicDashboardToken() {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: publicDashboardTokenKeys.all,
    queryFn: () =>
      apiClient.get<PublicDashboardTokenResponse>("/dashboard/public-token"),
  });
}

export function useGeneratePublicDashboardToken() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiClient.post<PublicDashboardTokenResponse>(
        "/dashboard/public-token",
        {}
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(publicDashboardTokenKeys.all, data);
    },
  });
}

export function useRevokePublicDashboardToken() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiClient.delete<{ deleted: true }>("/dashboard/public-token"),
    onSuccess: () => {
      queryClient.setQueryData(publicDashboardTokenKeys.all, {
        token: null,
        url: null,
      });
    },
  });
}
