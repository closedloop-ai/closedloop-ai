"use client";

import type { Artifact } from "@repo/api/src/types/artifact";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const templateKeys = {
  all: ["templates"] as const,
  orgTemplates: () => [...templateKeys.all, "org"] as const,
  orgTemplateBySubtype: (templateForSubtype: string) =>
    [...templateKeys.all, "org", "subtype", templateForSubtype] as const,
};

/**
 * Fetch all templates for the authenticated user's organization.
 * Returns artifacts where subtype=TEMPLATE.
 */
export function useOrgTemplates(
  options?: Omit<UseQueryOptions<Artifact[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: templateKeys.orgTemplates(),
    queryFn: () => apiClient.get<Artifact[]>("/templates"),
    staleTime: 10 * 60 * 1000, // 10 minutes - templates don't change frequently
    ...options,
  });
}

/**
 * Fetch a single template by artifact subtype.
 * Triggers lazy seeding of default templates on the backend.
 */
export function useOrgTemplateBySubtype(
  templateForSubtype: string,
  options?: Omit<UseQueryOptions<Artifact>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: templateKeys.orgTemplateBySubtype(templateForSubtype),
    queryFn: () => apiClient.get<Artifact>(`/templates/${templateForSubtype}`),
    staleTime: 10 * 60 * 1000, // 10 minutes - templates don't change frequently
    enabled: !!templateForSubtype,
    ...options,
  });
}
