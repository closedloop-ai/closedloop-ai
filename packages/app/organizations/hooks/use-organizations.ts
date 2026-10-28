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
  ORGANIZATION_MEMBERS_OFFSET_MAX,
  ORGANIZATION_MEMBERS_PAGE_LIMIT_MAX,
  type OrganizationMemberSummary,
  type OrganizationMembersPage,
  type OrganizationMembersSource,
} from "@repo/api/src/types/organization-members";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { onboardingKeys } from "../../onboarding/hooks/use-onboarding";
import { useApiClient } from "../../shared/api/use-api-client";

// Query keys
export const organizationKeys = {
  all: ["organizations"] as const,
  lists: () => [...organizationKeys.all, "list"] as const,
  details: () => [...organizationKeys.all, "detail"] as const,
  detail: (id: string) => [...organizationKeys.details(), id] as const,
  members: () => [...organizationKeys.all, "members"] as const,
  membersSource: () => [...organizationKeys.all, "members-source"] as const,
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
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: InviteMembersInput) =>
      apiClient.post<InviteMembersResponse>(
        "/organizations/invitations",
        input
      ),
    // The onboarding checklist's invite row completes off a server-side record
    // of the send, so the status has to be re-read once one lands — otherwise
    // the row stays unticked behind a five-minute `staleTime`. Invalidated, not
    // written: this response carries per-email invite outcomes, not a status.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: onboardingKeys.all });
    },
    // Both callers (the invite dialog and the onboarding step) run their own
    // `catch { toast.error(...) }` — the step also captures analytics — so opt
    // out of the global mutation error toast to avoid double-toasting failures.
    meta: { suppressDefaultErrorToast: true },
  });
}

/**
 * ISS-12135: the caller's whole organization roster (`GET /organizations/members`),
 * with its pages followed to the end so a long roster is never cut at the
 * server's page size. A roster that cannot be read to the end (past the
 * server's offset bound, or an empty page that still claims more) fails rather
 * than returning part of it as the whole.
 */
export function useOrganizationMembers(
  options?: Omit<
    UseQueryOptions<OrganizationMemberSummary[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: organizationKeys.members(),
    queryFn: async () => {
      const members: OrganizationMemberSummary[] = [];
      let offset = 0;
      while (offset <= ORGANIZATION_MEMBERS_OFFSET_MAX) {
        const page = await apiClient.get<OrganizationMembersPage>(
          `/organizations/members?limit=${ORGANIZATION_MEMBERS_PAGE_LIMIT_MAX}&offset=${offset}`
        );
        members.push(...page.members);
        if (!page.hasMore) {
          return members;
        }
        if (page.members.length === 0) {
          break;
        }
        offset += page.members.length;
      }
      throw new Error(
        `the organization roster could not be read to the end (stopped at offset ${offset})`
      );
    },
    ...options,
  });
}

/**
 * ISS-12135: where the roster comes from, as the API decides it, read from a
 * one-row page (`GET /organizations/members?limit=1`), a request every API
 * version accepts. `null` when the page carries no `source`, as an API from
 * before the field answers. Fixed for the life of a deployment, so it is read
 * once.
 */
export function useOrganizationMembersSource(
  options?: Omit<
    UseQueryOptions<OrganizationMembersSource | null>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: organizationKeys.membersSource(),
    queryFn: async () => {
      const page = await apiClient.get<OrganizationMembersPage>(
        `/organizations/members?limit=${MEMBERS_SOURCE_PAGE_LIMIT}`
      );
      return page.source ?? null;
    },
    staleTime: Number.POSITIVE_INFINITY,
    ...options,
  });
}

/** The smallest page the roster read accepts, which every API version serves. */
const MEMBERS_SOURCE_PAGE_LIMIT = 1;
