"use client";

import type { SessionFrustrationSettingResponse } from "@repo/api/src/types/settings";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
// Cross-slice: the frustration gate directly governs the Insights frustration
// trend, so toggling it must invalidate the insights cache (see onSuccess).
import { insightsKeys } from "../../insights/hooks/use-insights";
import { useApiClient } from "../../shared/api/use-api-client";

export const frustrationSettingKeys = {
  all: ["session-frustration-setting"] as const,
};

/**
 * FEA-4022: read the org's `calculateSessionFrustration` toggle. Identity is
 * derived from the auth token server-side; this drives the Insights frustration
 * facet and the admin settings toggle.
 */
export function useFrustrationSetting() {
  const apiClient = useApiClient();
  return useQuery({
    queryKey: frustrationSettingKeys.all,
    queryFn: () =>
      apiClient.get<SessionFrustrationSettingResponse>("/settings/frustration"),
    staleTime: 5 * 60 * 1000,
  });
}

/** FEA-4022: set the org's frustration toggle (admin-only, enforced server-side). */
export function useSetFrustrationSetting() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (calculateSessionFrustration: boolean) =>
      apiClient.put<SessionFrustrationSettingResponse>(
        "/settings/frustration",
        { calculateSessionFrustration }
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(frustrationSettingKeys.all, data);
      // FEA-4022 (T0/T21): the Agents insights query caches with
      // `staleTime: Infinity` and no mount/focus refetch, so flipping this gate
      // would otherwise leave the frustration chart stale — visible after
      // opt-out, or absent after opt-in — until some unrelated invalidation.
      // Invalidate every insights section so the frustration trend re-derives
      // against the new gate on the next render.
      queryClient.invalidateQueries({ queryKey: insightsKeys.all });
    },
  });
}
