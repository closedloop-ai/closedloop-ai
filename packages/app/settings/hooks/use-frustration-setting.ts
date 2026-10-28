"use client";

import type { SessionFrustrationSettingResponse } from "@repo/api/src/types/settings";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
// Cross-slice: the frustration gate directly governs the Insights frustration
// trend, so toggling it must invalidate the insights cache (see onSuccess).
import { insightsKeys } from "../../insights/hooks/use-insights";
import { useApiClient } from "../../shared/api/use-api-client";
import { currentQueryCacheScope } from "../../shared/query/query-client";

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
    // Both callers render the outcome INLINE, beside the control that failed —
    // the v2 Other Labs panel separates a 403 ("needs an organization admin")
    // and a 503 from a generic failure, and the legacy card renders its own
    // "Couldn't save that change" alert off `isError`. The shared client's
    // default `mutations.onError` would add a second, generic toast on top of
    // each, so a member's refused toggle reported both "Operation failed" and
    // the specific reason at once (#6392, tamsinb). Suppressed rather than
    // dropping the inline alerts: the inline text is the one that names WHY,
    // and it sits where the user is looking.
    meta: { suppressDefaultErrorToast: true },
    mutationFn: (calculateSessionFrustration: boolean) =>
      apiClient.put<SessionFrustrationSettingResponse>(
        "/settings/frustration",
        { calculateSessionFrustration }
      ),
    // ISS-7442: snapshot the cache identity at CALL time. `frustrationSettingKeys`
    // carries no identity of its own, so which tenant this write lands in is
    // decided by the client's scope at HASH time — and mutation callbacks are
    // rebuilt every render, so a live read here would be the identity at RESOLVE
    // time. Across a mid-flight organization switch that is the NEXT tenant,
    // which would then read this organization's response as its own fresh data.
    // Same call-time snapshot `use-onboarding.ts` takes for the same reason.
    onMutate: () => currentQueryCacheScope(queryClient),
    onSuccess: (data, _variables, scopeAtCall) => {
      if (currentQueryCacheScope(queryClient) !== scopeAtCall) {
        // The identity that issued this mutation is no longer the one the cache
        // answers for. Dropped rather than redirected to it: the shell clears
        // the whole cache on an organization change, so writing it back would
        // resurrect the single entry that clear just removed. The setting
        // refetches on the next visit.
        return;
      }
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
