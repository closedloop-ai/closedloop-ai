"use client";

import type { ComplianceResponse } from "@repo/api/src/types/analytics";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

/**
 * Query key factory for the compliance-gaps analytics slice.
 *
 * Root `["agent-component-compliance"]` is distinct from other agent slices
 * to prevent cross-cache collisions.
 */
export const agentComponentComplianceKeys = {
  all: ["agent-component-compliance"] as const,
  list: () => [...agentComponentComplianceKeys.all, "list"] as const,
};

/**
 * TanStack Query hook for the org-wide compliance-gaps view.
 *
 * Calls GET /agent-components/compliance (org-visible, withAnyAuth).
 * Returns distributions in auto_install mode that have targets with
 * installation or utilization gaps.
 *
 * @param options Standard TanStack Query options.
 *
 * @example
 *   const { data, isLoading, isError } = useAgentComponentCompliance();
 */
export function useAgentComponentCompliance(
  options?: Omit<UseQueryOptions<ComplianceResponse>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery<ComplianceResponse>({
    queryKey: agentComponentComplianceKeys.list(),
    queryFn: () =>
      apiClient.get<ComplianceResponse>("/agent-components/compliance"),
    ...options,
  });
}
