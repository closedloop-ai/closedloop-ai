"use client";

import type { CollectionCapabilities } from "@repo/api/src/types/comment-capabilities";
import type { CommentThreadDto } from "@repo/api/src/types/comment-thread-dto";
import type { CommentThreadSignalData } from "@repo/realtime-contract/signals";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import { useApiClient } from "../api/use-api-client";
import {
  type CommentsPaneLoadState,
  CommentsPaneLoadStatus,
} from "../components/comments/comments-pane-model";
import { traceCommentsLiveQueryOptions } from "../trace-comments/trace-comment-query";
import {
  type ArtifactCommentsCollection,
  type ArtifactCommentsTarget,
  artifactCommentKeys,
  createCommentRaceMarkers,
  mergeReloadedThreads,
  readArtifactCommentsCollection,
} from "./artifact-comments-cache";
import {
  createArtifactCommentsStore,
  refreshThread,
} from "./artifact-comments-store";
import { useCommentEventStream } from "./comment-event-stream";
import {
  type CommentsDataSource,
  createHttpCommentsDataSource,
} from "./comments-data-source";
import {
  type ArtifactCommentWrites,
  useArtifactCommentWrites,
} from "./use-artifact-comment-writes";

export type UseArtifactCommentsOptions = {
  dataSource: CommentsDataSource;
  /** The viewer's organization, for the realtime channel; the host reads it. */
  organizationId: string | null | undefined;
  enabled?: boolean;
};

export type ArtifactComments = {
  /** The resolved artifact; null until the first read names it. */
  artifactId: string | null;
  /** Null until the first read lands. */
  capabilities: CollectionCapabilities | null;
  threads: readonly CommentThreadDto[];
  loadState: CommentsPaneLoadState;
  /** Pane keys with a write in flight, for the pane's `pendingDraftKeys`. */
  pendingDraftKeys: readonly string[];
  onRetryLoad: () => void;
} & ArtifactCommentWrites;

const NO_THREADS: readonly CommentThreadDto[] = [];

/** The HTTP source over this shell's API client: web and desktop alike (PLN-2162 M2.2). */
export function useHttpCommentsDataSource(): CommentsDataSource {
  const api = useApiClient();
  return useMemo(() => createHttpCommentsDataSource(api), [api]);
}

/**
 * PLN-2162 M2.3: one artifact's comments on one surface, read through every
 * page, kept current by realtime signals and, while the channel is not live,
 * by the poll fallback.
 */
export function useArtifactComments(
  target: ArtifactCommentsTarget,
  { dataSource, organizationId, enabled = true }: UseArtifactCommentsOptions
): ArtifactComments {
  const queryClient = useQueryClient();
  const { id, surface } = target;
  const stableTarget = useMemo<ArtifactCommentsTarget>(
    () => (surface ? { id, surface } : { id }),
    [id, surface]
  );
  const queryKey = artifactCommentKeys.target(stableTarget);
  // Markers belong to one collection; a new target starts with none.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the target on purpose.
  const markers = useMemo(() => createCommentRaceMarkers(), [stableTarget]);
  const store = useMemo(
    () => createArtifactCommentsStore(queryClient, stableTarget, markers),
    [markers, queryClient, stableTarget]
  );

  const query = useQuery({
    ...traceCommentsLiveQueryOptions,
    queryKey,
    queryFn: async ({ signal }): Promise<ArtifactCommentsCollection> => {
      const read = await readArtifactCommentsCollection(
        dataSource,
        stableTarget,
        signal
      );
      const held = store.held();
      return held
        ? {
            ...read,
            threads: mergeReloadedThreads(
              held.threads,
              read.threads,
              markers,
              Date.now()
            ),
          }
        : read;
    },
    enabled,
  });
  const { refetch } = query;
  const artifactId = query.data?.artifactId ?? null;

  const inFlightRevisions = useRef(new Map<string, number>());
  const onThreadSignal = useCallback(
    ({ threadId, threadRevision }: CommentThreadSignalData) => {
      const held = store.held();
      if (!held) {
        refetch().catch(() => undefined);
        return;
      }
      const heldRevision = held.threads.find(
        (thread) => thread.id === threadId
      )?.revision;
      const requested = inFlightRevisions.current.get(threadId);
      if (
        (heldRevision !== undefined && heldRevision >= threadRevision) ||
        (requested !== undefined && requested >= threadRevision)
      ) {
        return;
      }
      inFlightRevisions.current.set(threadId, threadRevision);
      refreshThread(dataSource, store, threadId)
        // A thread that could not be re-read is caught up by a full reload.
        .catch(() => refetch())
        .catch(() => undefined)
        .finally(() => {
          if (inFlightRevisions.current.get(threadId) === threadRevision) {
            inFlightRevisions.current.delete(threadId);
          }
        });
    },
    [dataSource, refetch, store]
  );

  useCommentEventStream({
    organizationId,
    artifactId,
    onThreadSignal,
    onResync: () => {
      refetch().catch(() => undefined);
    },
    dataLoadedAt: () =>
      queryClient.getQueryState(queryKey)?.dataUpdatedAt || undefined,
    poll: async () => {
      if (enabled) {
        await refetch({ cancelRefetch: false, throwOnError: true });
      }
    },
  });

  const { writes, pendingKeys } = useArtifactCommentWrites({
    dataSource,
    store,
    target: stableTarget,
    artifactId,
  });

  return {
    artifactId,
    capabilities: query.data?.capabilities ?? null,
    threads: query.data?.threads ?? NO_THREADS,
    loadState: loadStateOf(query),
    pendingDraftKeys: pendingKeys,
    onRetryLoad: () => {
      refetch().catch(() => undefined);
    },
    ...writes,
  };
}

/** A failed read is an error, never an empty list (ISS-11213 AC6). */
function loadStateOf(query: {
  data: unknown;
  isError: boolean;
}): CommentsPaneLoadState {
  if (query.data !== undefined) {
    return { status: CommentsPaneLoadStatus.Ready };
  }
  return query.isError
    ? { status: CommentsPaneLoadStatus.Error }
    : { status: CommentsPaneLoadStatus.Loading };
}

/**
 * What a pane offers before the first read names the collection's
 * capabilities, or when there is no collection to read: nothing.
 */
export const NO_COLLECTION_CAPABILITIES: CollectionCapabilities = {
  anchorKinds: [],
  attach: false,
  commentKinds: [],
  createThread: false,
  delete: false,
  edit: false,
  linkOut: false,
  mention: false,
  react: false,
  reopen: false,
  reply: false,
  resolve: false,
  retrySync: false,
};
