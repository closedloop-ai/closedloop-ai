"use client";

import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

/**
 * PRD-536 §5: org-wide "has any desktop compute target ever connected?" signal
 * that distinguishes an empty-because-onboarding Sessions list from an
 * empty-because-filters one. A compute-target row exists in the org as soon as a
 * desktop agent registers, so once one has connected at least one target exists
 * — regardless of whether it is currently online.
 *
 * It calls the dedicated org-wide `GET /compute-targets/has-connected-agent`
 * endpoint rather than the user-scoped `GET /compute-targets` listing (which
 * filters to the viewer's own + org-shared targets). The Sessions list is an
 * org-wide view, so the onboarding-vs-filters decision must be org-wide too:
 * otherwise a teammate's unshared desktop would be invisible to another user and
 * that user's empty filtered/date result would be misclassified as "never
 * connected", flashing the onboarding CTA at an already-onboarded org.
 *
 * Lives in `@repo/app` so both the web Sessions page and the desktop
 * SessionsView share one signal. It uses a dedicated query key and does not
 * touch the app-owned full compute-target snapshot cache (which drives command
 * signing).
 */
export const hasConnectedAgentKeys = {
  all: ["agent-sessions", "has-connected-agent"] as const,
};

/** Response shape of `GET /compute-targets/has-connected-agent`. */
type HasConnectedAgentResponse = { hasConnectedAgent: boolean };

export function useHasConnectedAgent(
  options?: Omit<UseQueryOptions<boolean>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: hasConnectedAgentKeys.all,
    queryFn: async () => {
      const result = await apiClient.get<HasConnectedAgentResponse>(
        "/compute-targets/has-connected-agent"
      );
      return result.hasConnectedAgent;
    },
    ...options,
  });
}
