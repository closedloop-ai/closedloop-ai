"use client";

import type { Document } from "@repo/api/src/types/document";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const templateKeys = {
  all: ["templates"] as const,
  orgTemplates: () => [...templateKeys.all, "org"] as const,
  orgTemplateByType: (templateForType: string) =>
    [...templateKeys.all, "org", "type", templateForType] as const,
};

/**
 * Fetch all templates for the authenticated user's organization.
 * Returns artifacts where type=TEMPLATE.
 */
export function useOrgTemplates(
  options?: Omit<UseQueryOptions<Document[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: templateKeys.orgTemplates(),
    queryFn: () => apiClient.get<Document[]>("/templates"),
    staleTime: 10 * 60 * 1000, // 10 minutes - templates don't change frequently
    ...options,
  });
}

/**
 * Fetch a single template by artifact type.
 * Triggers lazy seeding of default templates on the backend.
 */
export function useOrgTemplateByType(
  templateForType: string,
  options?: Omit<UseQueryOptions<Document>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: templateKeys.orgTemplateByType(templateForType),
    queryFn: () => apiClient.get<Document>(`/templates/${templateForType}`),
    staleTime: 10 * 60 * 1000, // 10 minutes - templates don't change frequently
    enabled: !!templateForType,
    ...options,
  });
}
