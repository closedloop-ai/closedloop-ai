import type { CommentThreadDto } from "@repo/api/src/types/comment-thread-dto";
import type { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/api-error";
import { currentQueryCacheScope } from "../query/query-client";
import {
  type ArtifactCommentsCollection,
  type ArtifactCommentsTarget,
  artifactCommentKeys,
  type CommentRaceMarkers,
  markThread,
  removedSince,
  removeThread,
  threadBelongsToTarget,
  upsertThread,
} from "./artifact-comments-cache";
import type { CommentsDataSource } from "./comments-data-source";

/** Where and when a read or write began, taken before its request is sent. */
export type ArtifactCommentsRequestStart = {
  scope: string;
  startedAt: number;
};

/**
 * Writes into one target's cached collection. Each write is bound to the
 * cache scope its operation started in (ISS-7442), so a response that lands
 * after an organization switch is dropped, and a response to a request that
 * began before the thread was removed here is dropped too. A patch keeps the
 * collection's `dataUpdatedAt`, which stays the time of the last full read:
 * the realtime client compares it with the join to decide a resync.
 */
export type ArtifactCommentsStore = {
  held: () => ArtifactCommentsCollection | undefined;
  begin: () => ArtifactCommentsRequestStart;
  upsert: (
    start: ArtifactCommentsRequestStart,
    thread: CommentThreadDto
  ) => void;
  remove: (start: ArtifactCommentsRequestStart, threadId: string) => void;
};

export function createArtifactCommentsStore(
  queryClient: QueryClient,
  target: ArtifactCommentsTarget,
  markers: CommentRaceMarkers
): ArtifactCommentsStore {
  const queryKey = artifactCommentKeys.target(target);
  const update = (
    scope: string,
    change: (threads: CommentThreadDto[]) => CommentThreadDto[]
  ) => {
    if (currentQueryCacheScope(queryClient) !== scope) {
      return;
    }
    const updatedAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt;
    queryClient.setQueryData<ArtifactCommentsCollection>(
      queryKey,
      (held) => (held ? { ...held, threads: change(held.threads) } : held),
      updatedAt ? { updatedAt } : undefined
    );
  };
  const remove = (scope: string, threadId: string) => {
    markThread(markers.removed, threadId, Date.now());
    update(scope, (threads) => removeThread(threads, threadId));
  };
  return {
    held: () => queryClient.getQueryData<ArtifactCommentsCollection>(queryKey),
    begin: () => ({
      scope: currentQueryCacheScope(queryClient),
      startedAt: Date.now(),
    }),
    upsert: ({ scope, startedAt }, thread) => {
      if (
        !threadBelongsToTarget(thread, target) ||
        removedSince(markers, thread.id, startedAt)
      ) {
        return;
      }
      const held =
        queryClient.getQueryData<ArtifactCommentsCollection>(queryKey);
      if (held?.artifactId && thread.artifactId !== held.artifactId) {
        // Relinking a pull request moves its threads and signals both
        // branches; the one it left drops its copy.
        remove(scope, thread.id);
        return;
      }
      if (held && !held.threads.some(({ id }) => id === thread.id)) {
        // A reload already in flight predates a thread a signal or write
        // just added, as it does a local create.
        markThread(markers.created, thread.id, Date.now());
      }
      update(scope, (threads) => upsertThread(threads, thread));
    },
    remove: ({ scope }, threadId) => remove(scope, threadId),
  };
}

/** Re-reads one thread into the collection; a thread the server no longer has is removed. */
export async function refreshThread(
  dataSource: CommentsDataSource,
  store: ArtifactCommentsStore,
  threadId: string
): Promise<void> {
  const start = store.begin();
  try {
    store.upsert(start, await dataSource.getThread(threadId));
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound()) {
      store.remove(start, threadId);
      return;
    }
    throw error;
  }
}
