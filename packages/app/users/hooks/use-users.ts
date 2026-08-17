"use client";

import type {
  UpdateUserInput,
  User,
  UserContributionHeatmap,
  UserProfileHeadline,
  UserProfileMilestones,
  UserProfileStanding,
  UserProfileStats,
} from "@repo/api/src/types/user";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";
import { buildSearchParams } from "../../shared/lib/format-utils";

/** Filters for the ranged user-profile stats (FEA-4064). */
export type UserStatsFilters = {
  /** Inclusive ISO lower bound for the ranged headline metrics. */
  startDate?: string;
};

// Query keys
export const userKeys = {
  all: ["users"] as const,
  lists: () => [...userKeys.all, "list"] as const,
  organizationUsers: () => [...userKeys.lists(), "organization"] as const,
  currentUser: () => [...userKeys.all, "current"] as const,
  detail: (userId: string) => [...userKeys.all, "detail", userId] as const,
  stats: (userId: string, filters: UserStatsFilters = {}) =>
    [...userKeys.all, "stats", userId, filters] as const,
  // FEA-4064: range-scoped headline metrics. Keyed by `filters` so a range
  // change re-fetches ONLY this query.
  headline: (userId: string, filters: UserStatsFilters = {}) =>
    [...userKeys.all, "headline", userId, filters] as const,
  // FEA-4064: fixed-window contribution heatmap widget. NOT keyed by `filters`,
  // so a range change never invalidates or re-fetches it.
  contributions: (userId: string) =>
    [...userKeys.all, "contributions", userId] as const,
  // FEA-4108: standing widget (consecutive-active-days streak). Not range-keyed;
  // loads independently of the headline/heatmap.
  standing: (userId: string) => [...userKeys.all, "standing", userId] as const,
  // FEA-4108: lifetime milestones widget. Not range-keyed; loads independently.
  milestones: (userId: string) =>
    [...userKeys.all, "milestones", userId] as const,
};

// Queries
export function useCurrentUser(
  options?: Omit<UseQueryOptions<User>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: userKeys.currentUser(),
    queryFn: () => apiClient.get<User>("/me"),
    staleTime: 5 * 60 * 1000, // 5 minutes - user info doesn't change frequently
    ...options,
  });
}

export function useOrganizationUsers(
  options?: Omit<UseQueryOptions<User[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: userKeys.organizationUsers(),
    queryFn: () => apiClient.get<User[]>("/users"),
    ...options,
  });
}

export function useUser(
  userId: string,
  options?: Omit<UseQueryOptions<User>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: userKeys.detail(userId),
    queryFn: () => apiClient.get<User>(`/users/${userId}`),
    enabled: !!userId,
    ...options,
  });
}

export function useUserStats(
  userId: string,
  filters: UserStatsFilters = {},
  options?: Omit<UseQueryOptions<UserProfileStats>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: userKeys.stats(userId, filters),
    queryFn: () => {
      const qs = buildSearchParams(filters).toString();
      return apiClient.get<UserProfileStats>(
        `/users/${userId}/stats${qs ? `?${qs}` : ""}`
      );
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!userId,
    ...options,
  });
}

/**
 * Range-scoped profile headline metrics (FEA-4064).
 *
 * This is the ONLY profile query the range toggle re-fetches: its key includes
 * `filters`, so changing the window re-runs this query alone. It is independent
 * of `useUserContributionHeatmap` — a slow or failing heatmap read never blocks
 * or fails these headline numbers, and a range click never re-issues the
 * trailing-year heatmap SQL.
 */
export function useUserProfileHeadline(
  userId: string,
  filters: UserStatsFilters = {},
  options?: Omit<UseQueryOptions<UserProfileHeadline>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: userKeys.headline(userId, filters),
    queryFn: () => {
      const qs = buildSearchParams(filters).toString();
      return apiClient.get<UserProfileHeadline>(
        `/users/${userId}/stats/headline${qs ? `?${qs}` : ""}`
      );
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!userId,
    ...options,
  });
}

/**
 * Fixed-window contribution heatmap widget (FEA-4064).
 *
 * A heatmap is a trailing-year grid by definition, so this query takes no
 * range filter and its key is not scoped by the toggle — a range change never
 * invalidates or re-fetches it. It owns its own loading/error state so a
 * failure degrades to an empty/error heatmap widget without affecting the
 * headline query (widget independence).
 */
export function useUserContributionHeatmap(
  userId: string,
  options?: Omit<
    UseQueryOptions<UserContributionHeatmap>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: userKeys.contributions(userId),
    queryFn: () =>
      apiClient.get<UserContributionHeatmap>(`/users/${userId}/contributions`),
    staleTime: 5 * 60 * 1000,
    enabled: !!userId,
    ...options,
  });
}

/**
 * Standing widget for the profile (FEA-4108): the consecutive-active-days
 * streak. Loads independently of the headline and heatmap — a slow or failing
 * streak read never blocks the rest of the profile (widget independence). Not
 * scoped by the range toggle. Rank is NOT part of this payload: the global
 * cross-org ranking service is unbuilt (FEA-4122).
 */
export function useUserProfileStanding(
  userId: string,
  options?: Omit<UseQueryOptions<UserProfileStanding>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: userKeys.standing(userId),
    queryFn: () =>
      apiClient.get<UserProfileStanding>(`/users/${userId}/standing`),
    staleTime: 5 * 60 * 1000,
    enabled: !!userId,
    ...options,
  });
}

/**
 * Lifetime milestones/achievements widget for the profile (FEA-4108). Loads
 * independently of the other profile widgets — a slow or failing read degrades
 * to a hidden/error Milestones section without blocking the headline (widget
 * independence). Not scoped by the range toggle.
 */
export function useUserProfileMilestones(
  userId: string,
  options?: Omit<UseQueryOptions<UserProfileMilestones>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: userKeys.milestones(userId),
    queryFn: () =>
      apiClient.get<UserProfileMilestones>(`/users/${userId}/milestones`),
    staleTime: 5 * 60 * 1000,
    enabled: !!userId,
    ...options,
  });
}

// Mutations
export function useUpdateUser() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateUserInput) => {
      const { id, ...body } = input;
      return apiClient.put<User>(`/users/${id}`, body);
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: userKeys.organizationUsers() });
      queryClient.invalidateQueries({ queryKey: userKeys.currentUser() });
      queryClient.invalidateQueries({ queryKey: userKeys.detail(input.id) });
    },
  });
}
