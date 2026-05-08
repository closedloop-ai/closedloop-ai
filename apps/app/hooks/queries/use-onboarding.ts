"use client";

import type { OnboardingStatus } from "@repo/api/src/types/onboarding";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const onboardingKeys = {
  all: ["onboarding"] as const,
  status: () => [...onboardingKeys.all, "status"] as const,
};

// Queries
export function useOnboardingStatus(
  options?: Omit<UseQueryOptions<OnboardingStatus>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: onboardingKeys.status(),
    queryFn: () => apiClient.get<OnboardingStatus>("/onboarding"),
    staleTime: 5 * 60 * 1000,
    ...options,
  });
}

// Mutations
export function useCompleteWizard() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: {
      createdTeamId?: string;
      createdProjectId?: string;
    }) => apiClient.put<OnboardingStatus>("/onboarding/complete-wizard", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: onboardingKeys.all });
    },
  });
}

export function useDismissChecklist() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: () =>
      apiClient.put<OnboardingStatus>("/onboarding/dismiss-checklist", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: onboardingKeys.all });
    },
  });
}
