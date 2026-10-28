import { CommentSyncStatus } from "@repo/api/src/types/comment-thread-dto";

/**
 * Kerensa, 2026-10-05: a GitHub comment whose sync state is not SYNCED is an
 * unconfirmed Symphony write. One with no sync state counts as confirmed.
 */
export function hasUnconfirmedGitHubSync(comment: {
  syncStates: readonly { state: string }[];
}): boolean {
  return comment.syncStates.some(
    (syncState) => syncState.state !== CommentSyncStatus.Synced
  );
}
