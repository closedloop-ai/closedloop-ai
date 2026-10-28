"use client";

import { useApiClient } from "@repo/app/shared/api/use-api-client";
import {
  MAX_MENTION_SUGGESTIONS,
  MentionSuggestionList,
} from "@repo/app/shared/components/mention-suggestion-list";
import {
  useCurrentUser,
  useOrganizationUsers,
} from "@repo/app/users/hooks/use-users";
import type {
  DocSyncConfig,
  DocSyncMentionSuggestionsProps,
  DocSyncResolvedUser,
} from "@repo/collaboration/client/doc-sync-config";
import { mentionMatchDisplayName } from "@repo/collaboration/shared/mention-matching";
import { getConsistentColor } from "@repo/collaboration/shared/user-colors";
import { DOC_SYNC_TOKEN_PATH } from "@repo/realtime-contract/protocol";
import { createElement, useMemo } from "react";

/**
 * The host half of a `DocSyncRoom` (PLN-2189 T-3.1): tokens from
 * `POST /doc-sync/token`, and identity from the same org user list the
 * Liveblocks resolvers read (`createResolveUsers`,
 * `createResolveMentionSuggestions`), and the comment composer's suggestion
 * list and cap for the body mention picker (T-2.8).
 */
export function useDocSyncConfig(): DocSyncConfig {
  const apiClient = useApiClient();
  const { data: currentUser } = useCurrentUser();
  const { data: users = NO_USERS } = useOrganizationUsers();
  const currentUserId = currentUser?.id;

  const self = useMemo(
    () =>
      currentUserId
        ? { id: currentUserId, color: getConsistentColor(currentUserId) }
        : null,
    [currentUserId]
  );

  const resolveUser = useMemo(() => {
    const byId = new Map<string, DocSyncResolvedUser>(
      users.map((user) => [
        user.id,
        {
          name: mentionMatchDisplayName(user),
          avatarUrl: user.avatarUrl ?? undefined,
        },
      ])
    );
    return (id: string) => byId.get(id);
  }, [users]);

  return useMemo(
    () => ({
      fetchToken: (room: string) =>
        apiClient.post<unknown>(DOC_SYNC_TOKEN_PATH, { room }),
      self,
      resolveUser,
      mentionCandidates: users,
      maxMentionSuggestions: MAX_MENTION_SUGGESTIONS,
      renderMentionSuggestions,
    }),
    [apiClient, self, resolveUser, users]
  );
}

const NO_USERS: [] = [];

/** A caret has no width, so the menu keeps its own. */
function renderMentionSuggestions(props: DocSyncMentionSuggestionsProps) {
  return createElement(MentionSuggestionList, {
    ...props,
    matchAnchorWidth: false,
  });
}
