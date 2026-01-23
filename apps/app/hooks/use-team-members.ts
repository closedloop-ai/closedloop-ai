"use client";

import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { useEffect, useState } from "react";
import { getTeamMembers } from "@/app/actions/teams";
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
function transformMembers(
  results: Awaited<ReturnType<typeof getTeamMembers>>[]
): User[] {
  const memberMap = new Map<string, User>();

  for (const result of results) {
    if (!result.success) {
      continue;
    }

    for (const member of result.data) {
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
  const [members, setMembers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || teamIds.length === 0) {
      setMembers([]);
      return;
    }

    let cancelled = false;

    async function fetchMembers() {
      setIsLoading(true);
      setError(null);

      try {
        const results = await Promise.all(
          teamIds.map((teamId) => getTeamMembers(teamId))
        );

        if (!cancelled) {
          setMembers(transformMembers(results));
        }
      } catch (err) {
        if (!cancelled) {
          setError("Failed to fetch team members");
          console.error("Error fetching team members:", err);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    fetchMembers();

    return () => {
      cancelled = true;
    };
  }, [enabled, teamIds]);

  return { members, isLoading, error };
}
