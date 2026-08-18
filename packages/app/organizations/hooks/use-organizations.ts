"use client";

import type {
  InviteMembersInput,
  InviteMembersResponse,
} from "@repo/api/src/types/onboarding";
import type {
  Organization,
  UpdateOrganizationInput,
} from "@repo/api/src/types/organization";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

// Query keys
export const organizationKeys = {
  all: ["organizations"] as const,
  lists: () => [...organizationKeys.all, "list"] as const,
  details: () => [...organizationKeys.all, "detail"] as const,
  detail: (id: string) => [...organizationKeys.details(), id] as const,
};

// Queries
export function useOrganizations(
  options?: Omit<UseQueryOptions<Organization[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: organizationKeys.lists(),
    queryFn: () => apiClient.get<Organization[]>("/organizations"),
    ...options,
  });
}

export function useOrganization(
  id: string,
  options?: Omit<UseQueryOptions<Organization>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: organizationKeys.detail(id),
    queryFn: () => apiClient.get<Organization>(`/organizations/${id}`),
    enabled: !!id,
    ...options,
  });
}

// Mutations
export function useUpdateOrganization() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateOrganizationInput) => {
      const { id, ...data } = input;
      return apiClient.put<Organization>(`/organizations/${id}`, data);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: organizationKeys.detail(variables.id),
      });
      queryClient.invalidateQueries({ queryKey: organizationKeys.lists() });
    },
  });
}

/**
 * Invite teammates into the caller's current organization ("Invite your team",
 * PRD-532 §5.4). Mints real Clerk org invitations via the BFF route
 * `POST /organizations/invitations`; on accept, the Clerk membership webhook
 * syncs a durable MEMBER into the existing org. Shared by the web onboarding
 * invite step and the desktop sidebar affordance.
 */
export function useInviteMembers() {
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: InviteMembersInput) =>
      apiClient.post<InviteMembersResponse>(
        "/organizations/invitations",
        input
      ),
    // Both callers (the invite dialog and the onboarding step) run their own
    // `catch { toast.error(...) }` — the step also captures analytics — so opt
    // out of the global mutation error toast to avoid double-toasting failures.
    meta: { suppressDefaultErrorToast: true },
  });
}
