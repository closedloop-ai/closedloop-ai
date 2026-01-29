"use client";

import type { User } from "@repo/api/src/types/organization";
import { Room } from "@repo/collaboration/room";
import type { ReactNode } from "react";
import { useCallback } from "react";
import { useApiClient } from "@/hooks/use-api-client";

export const CollaborationProvider = ({
  orgId,
  children,
}: {
  orgId: string;
  children: ReactNode;
}) => {
  const apiClient = useApiClient();

  const resolveUsers = useCallback(
    async ({ userIds }: { userIds: string[] }) => {
      // TODO: The /users endpoint does not support ids as a query parameter.
      const users = await apiClient.get<User[]>(
        `/users?ids=${userIds.join(",")}`
      );
      // Transform to Liveblocks UserMeta["info"] format
      return users.map((user) => ({
        name:
          user.firstName && user.lastName
            ? `${user.firstName} ${user.lastName}`
            : user.email,
        avatar: user.avatarUrl ?? undefined,
        color: getUserColor(user.id),
      }));
    },
    [apiClient]
  );

  const resolveMentionSuggestions = useCallback(
    async ({ text }: { text: string }) => {
      // TODO: The /users endpoint does not support search as a query parameter.
      const users = await apiClient.get<User[]>(
        `/users/search?q=${encodeURIComponent(text)}`
      );
      // Return user IDs for mention suggestions
      return users.map((user) => user.id);
    },
    [apiClient]
  );

  return (
    <Room
      authEndpoint="/api/collaboration/auth"
      fallback={
        <div className="px-3 text-muted-foreground text-xs">Loading...</div>
      }
      id={`${orgId}:presence`}
      resolveMentionSuggestions={resolveMentionSuggestions}
      resolveUsers={resolveUsers}
    >
      {children}
    </Room>
  );
};

/** biome-ignore-start lint/suspicious/noBitwiseOperators: bitwise operators are used for hashing */
// Generate a consistent color based on user ID
function getUserColor(userId: string): string {
  const colors = [
    "#E57373",
    "#F06292",
    "#BA68C8",
    "#9575CD",
    "#7986CB",
    "#64B5F6",
    "#4FC3F7",
    "#4DD0E1",
    "#4DB6AC",
    "#81C784",
    "#AED581",
    "#DCE775",
    "#FFD54F",
    "#FFB74D",
    "#FF8A65",
  ];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
    hash &= hash;
  }
  return colors[Math.abs(hash) % colors.length];
}
/** biome-ignore-end lint/suspicious/noBitwiseOperators: bitwise operators are used for hashing */
