"use client";

import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import type { CommentThreadDto } from "@repo/api/src/types/comment-thread-dto";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { ApiError } from "../api/api-error";
import type { CommentsPaneCallbacks } from "../components/comments/comments-pane-contract";
import {
  deleteActionKey,
  editDraftKey,
  NEW_THREAD_DRAFT_KEY,
  reopenActionKey,
  replyDraftKey,
  resolveActionKey,
  retrySyncActionKey,
} from "../components/comments/comments-pane-model";
import type { ArtifactCommentsTarget } from "./artifact-comments-cache";
import {
  type ArtifactCommentsStore,
  refreshThread,
} from "./artifact-comments-store";
import type { CommentsDataSource } from "./comments-data-source";

type ArtifactCommentWriteKey =
  | "onCreateThread"
  | "onReply"
  | "onEdit"
  | "onDelete"
  | "onResolve"
  | "onReopen"
  | "onRetrySync";

/** The pane's write callbacks, each returning the write's promise. */
export type ArtifactCommentWrites = {
  [Key in ArtifactCommentWriteKey]-?: (
    ...args: Parameters<NonNullable<CommentsPaneCallbacks[Key]>>
  ) => Promise<void>;
};

/**
 * PLN-2162 M2.3 writes. One promise per pane key: a second submit while the
 * first is in flight gets the same promise, never a second request, and the
 * in-flight keys are what the pane renders as pending. Each write patches the
 * thread from its response. A failure rejects, so the pane keeps the draft,
 * and goes through the shared client's default mutation error toast, the one
 * today's failed trace-comment edit shows (PLN-2162 decision 8). A
 * `stale_revision` edit first re-reads the thread, so the newer revision
 * renders beside the kept draft.
 */
export function useArtifactCommentWrites({
  dataSource,
  store,
  target,
  artifactId,
}: {
  dataSource: CommentsDataSource;
  store: ArtifactCommentsStore;
  target: ArtifactCommentsTarget;
  artifactId: string | null;
}): { writes: ArtifactCommentWrites; pendingKeys: readonly string[] } {
  const identity = `${target.id}|${target.surface ?? ""}`;
  const inFlight = useRef(new Map<string, Promise<void>>());
  const clientIds = useRef(
    new Map<string, { submission: string; clientId: string }>()
  );
  const [pending, setPending] = useState<readonly string[]>([]);
  const { mutateAsync } = useMutation({
    mutationFn: (write: () => Promise<void>) => write(),
  });

  const submit = useCallback(
    (key: string, write: () => Promise<void>): Promise<void> => {
      const scopedKey = `${identity}|${key}`;
      const running = inFlight.current.get(scopedKey);
      if (running) {
        return running;
      }
      const publish = () => setPending([...inFlight.current.keys()]);
      const promise = mutateAsync(write).finally(() => {
        inFlight.current.delete(scopedKey);
        publish();
      });
      inFlight.current.set(scopedKey, promise);
      publish();
      return promise;
    },
    [identity, mutateAsync]
  );

  const writes = useMemo<ArtifactCommentWrites>(() => {
    const patch = async (request: () => Promise<CommentThreadDto>) => {
      const start = store.begin();
      store.upsert(start, await request());
    };
    /**
     * One idempotency id per submitted draft until it lands: a retry of the
     * same submission is deduplicated, and a changed draft gets a new id, so
     * the server never answers it with an earlier submission that committed.
     */
    const clientIdFor = (key: string, submission: object) => {
      const scopedKey = `${identity}|${key}`;
      const submitted = JSON.stringify(submission);
      const existing = clientIds.current.get(scopedKey);
      if (existing?.submission === submitted) {
        return existing.clientId;
      }
      const minted = globalThis.crypto.randomUUID();
      clientIds.current.set(scopedKey, {
        submission: submitted,
        clientId: minted,
      });
      return minted;
    };
    const landed = (key: string) =>
      clientIds.current.delete(`${identity}|${key}`);
    return {
      onCreateThread: ({ anchor, body, kind, mentions }) =>
        submit(NEW_THREAD_DRAFT_KEY, async () => {
          const start = store.begin();
          const draft = {
            anchor,
            body,
            ...(kind ? { kind } : {}),
            ...(mentions ? { mentions } : {}),
            ...(target.surface ? { surface: target.surface } : {}),
          };
          const created = await dataSource.createThread(
            artifactId ?? target.id,
            { ...draft, clientId: clientIdFor(NEW_THREAD_DRAFT_KEY, draft) }
          );
          landed(NEW_THREAD_DRAFT_KEY);
          store.upsert(start, created);
        }),
      onReply: (threadId, { body, mentions }) => {
        const key = replyDraftKey(threadId);
        return submit(key, async () => {
          const draft = { body, ...(mentions ? { mentions } : {}) };
          await patch(() =>
            dataSource.reply(threadId, {
              ...draft,
              clientId: clientIdFor(key, draft),
            })
          );
          landed(key);
        });
      },
      onEdit: (commentId, { body, expectedRevision, mentions }) =>
        submit(editDraftKey(commentId), async () => {
          const start = store.begin();
          try {
            store.upsert(
              start,
              await dataSource.update(commentId, {
                body,
                expectedRevision,
                ...(mentions ? { mentions } : {}),
              })
            );
          } catch (error) {
            const threadId = staleRevisionThreadId(error, store, commentId);
            if (threadId) {
              // A failed re-read keeps the held revision; the edit's own
              // error is what the viewer hears either way.
              await refreshThread(dataSource, store, threadId).catch(
                () => undefined
              );
            }
            throw error;
          }
        }),
      onDelete: ({ commentId, threadId }) =>
        submit(deleteActionKey(commentId), async () => {
          await dataSource.delete(commentId);
          // The delete landed; a failed re-read keeps the held thread rather
          // than reporting the delete as failed.
          await refreshThread(dataSource, store, threadId).catch(
            () => undefined
          );
        }),
      onResolve: (threadId) =>
        submit(resolveActionKey(threadId), () =>
          patch(() => dataSource.resolve(threadId))
        ),
      onReopen: (threadId) =>
        submit(reopenActionKey(threadId), () =>
          patch(() => dataSource.reopen(threadId))
        ),
      onRetrySync: (threadId) =>
        submit(retrySyncActionKey(threadId), () =>
          patch(() => dataSource.retrySync(threadId))
        ),
    };
  }, [artifactId, dataSource, identity, store, submit, target]);

  // In-flight keys stay scoped by target, so a write still running on the
  // previous target neither blocks nor overwrites this one's.
  const pendingKeys = useMemo(
    () =>
      pending.flatMap((entry) =>
        entry.startsWith(`${identity}|`)
          ? [entry.slice(identity.length + 1)]
          : []
      ),
    [identity, pending]
  );

  return { writes, pendingKeys };
}

/** The thread to re-read when an edit lost to a newer revision. */
function staleRevisionThreadId(
  error: unknown,
  store: ArtifactCommentsStore,
  commentId: string
): string | null {
  if (
    !(
      error instanceof ApiError && error.code === CommentErrorCode.StaleRevision
    )
  ) {
    return null;
  }
  const thread = store
    .held()
    ?.threads.find((held) =>
      held.comments.some((comment) => comment.id === commentId)
    );
  return thread?.id ?? null;
}
