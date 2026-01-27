"use client";

import type { TeamMember } from "@repo/api/src/types/teams";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { useQueries } from "@tanstack/react-query";
import { teamKeys } from "@/hooks/queries/use-teams";
import { useApiClient } from "@/hooks/use-api-client";
import { getUserDisplayName, getUserInitials } from "@/lib/user-utils";

type UseTeamMembersOptions = {
  /** Team IDs to fetch members for */
  teamIds: string[];
  /** Only fetch when this is true (e.g., when a modal is open) */
  enabled?: boolean;
};

type UseTeamMembersResult = {
  /** Transformed team members ready for UserSelectPopover */
  members: User[];
  /** Loading state */
  isLoading: boolean;
  /** Error message if fetch failed */
  error: string | null;
};

/**
 * Transform API team members to User format for UserSelectPopover.
 */
function transformMembers(memberArrays: TeamMember[][]): User[] {
  const memberMap = new Map<string, User>();

  for (const members of memberArrays) {
    for (const member of members) {
      if (memberMap.has(member.user.id)) {
        continue;
      }

      memberMap.set(member.user.id, {
        id: member.user.id,
        name: getUserDisplayName(member.user),
        email: member.user.email,
        avatarUrl: member.user.avatarUrl || undefined,
        initials: getUserInitials(member.user.firstName, member.user.lastName),
      });
    }
  }

  return Array.from(memberMap.values());
}

/**
 * Hook to fetch and transform team members for use with UserSelectPopover.
 * Supports fetching members from multiple teams and deduplicates by user ID.
 */
export function useTeamMembers({
  teamIds,
  enabled = true,
}: UseTeamMembersOptions): UseTeamMembersResult {
  const apiClient = useApiClient();

  const queries = useQueries({
    queries: teamIds.map((teamId) => ({
      queryKey: teamKeys.members(teamId),
      queryFn: () => apiClient.get<TeamMember[]>(`/teams/${teamId}/members`),
      enabled: enabled && teamIds.length > 0,
    })),
  });

  const isLoading = queries.some((q) => q.isLoading);
  const hasError = queries.some((q) => q.isError);
  const allData = queries
    .filter((q) => q.data)
    .map((q) => q.data as TeamMember[]);

  return {
    members: transformMembers(allData),
    isLoading,
    error: hasError ? "Failed to fetch team members" : null,
  };
}
