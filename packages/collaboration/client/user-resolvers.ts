/**
 * User resolution functions for Liveblocks mentions
 * Handles mapping user IDs to display info and providing mention suggestions
 */

import {
  mentionMatchDisplayName,
  mentionQueryMatchesUser,
} from "../shared/mention-matching";
import { getConsistentColor } from "../shared/user-colors";

export type UserInfo = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  avatarUrl: string | null;
  active: boolean;
};

/**
 * Creates a function that resolves user IDs to display info for Liveblocks
 * Called automatically when rendering comments/mentions
 */
export function createResolveUsers(users: UserInfo[]) {
  return ({ userIds }: { userIds: string[] }) => {
    return userIds.map((userId) => {
      const user = users.find((u) => u.id === userId);
      if (!user) {
        return undefined;
      }

      // Generate display name: "FirstName LastName" or fallback to email
      const name = mentionMatchDisplayName(user);

      return {
        name,
        avatar: user.avatarUrl ?? undefined,
        color: getConsistentColor(user.id),
      };
    });
  };
}

/**
 * Creates a function that provides filtered user IDs for mention autocomplete
 * Called with debouncing when user types "@" in comments
 */
export function createResolveMentionSuggestions(users: UserInfo[]) {
  return ({ text }: { text: string }) => {
    // Filter to active users only
    const activeUsers = users.filter((u) => u.active);

    // Filter by name or email containing search text (case-insensitive); an
    // empty query matches all active users.
    return activeUsers
      .filter((user) => mentionQueryMatchesUser(user, text))
      .map((u) => u.id);
  };
}
