"use client";

import type { CommentThreadWithComments } from "@repo/api/src/types/comment";
import {
  DocumentThreadAnchorStatus,
  resolveAnchorStatusKernel,
} from "@repo/api/src/types/comment";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";
import { getUserDisplayName } from "../../shared/lib/user-utils";
import type { CommentThreadItem } from "../components/comments-section";

export const documentCommentKeys = {
  all: ["document-comments"] as const,
  list: (documentId: string) =>
    [...documentCommentKeys.all, documentId] as const,
};

/**
 * Reads the artifact-level comment threads for a document from the same store
 * the composer writes to (`GET /documents/:id/threads`). The API returns the
 * DB projection of the Liveblocks-backed comment threads, so the composer's
 * `POST /documents/:id/threads` create is reflected here after invalidation.
 *
 * The route returns every thread on the artifact — anchored (in-document
 * selection) threads as well as the unanchored artifact-level ones. Because
 * the bottom Comments composer only creates and represents artifact-level
 * threads, this hook filters anchored threads out client-side (via the shared
 * {@link resolveAnchorStatusKernel}, with the same `?? artifact-level` fallback
 * the web feed uses for legacy threads that predate the explicit anchor field)
 * so the list stays in sync with what the composer can produce.
 *
 * `enabled` defers the fetch until the caller actually reveals the list (the
 * Comments section is collapsed by default), avoiding an on-mount request on
 * every document page.
 */
export function useDocumentComments(documentId: string, enabled = true) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: documentCommentKeys.list(documentId),
    queryFn: async () => {
      const threads = await apiClient.get<CommentThreadWithComments[]>(
        `/documents/${documentId}/threads`
      );
      return threads.filter(isArtifactLevelThread).map(toCommentThreadItem);
    },
    enabled,
  });
}

/**
 * Posts a new artifact-level comment on a document. Omitting `anchorText`
 * routes the API to `createArtifactLevelDocumentThread`, the unanchored
 * document-level thread that the bottom Comments composer represents. On
 * success the thread list is invalidated so the new comment appears.
 */
export function useCreateDocumentComment(documentId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: string) =>
      apiClient.post<{ commentId: string; threadId: string }>(
        `/documents/${documentId}/threads`,
        { body }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: documentCommentKeys.list(documentId),
      });
    },
  });
}

/**
 * Replies to a document comment thread (`POST /threads/:threadId/replies`).
 * Threading is flat, matching the shipped backend (FEA-3950): every reply
 * attaches to the thread, so no parent-comment id is sent. Anyone with view
 * access on the document may reply — the route does NOT gate replying on edit
 * access. On success the thread list is invalidated so the reply appears.
 *
 * The document-thread reply contract accepts a body only; @-mention IDs are a
 * later backend slice, so any "@Name" the author typed is preserved verbatim in
 * the body text (and chipped on read against the org member list) rather than
 * sent as a structured mention field the route would reject.
 */
export function useReplyToDocumentComment(documentId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ threadId, body }: { threadId: string; body: string }) =>
      apiClient.post<{ commentId: string; threadId: string }>(
        `/documents/${documentId}/threads/${threadId}/replies`,
        { body }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: documentCommentKeys.list(documentId),
      });
    },
  });
}

/**
 * Resolves or reopens a document comment thread. Participant-resolve (FEA-4092):
 * the thread author or any replier may resolve; only the author may reopen. Both
 * halves are enforced server-side (a disallowed actor gets 403); the UI mirrors
 * the rule via {@link canResolveDocumentThread} / {@link canReopenDocumentThread}
 * so the resolve control never offers an action the viewer cannot take. On
 * success the thread list is invalidated so the thread moves between the open and
 * resolved groups.
 */
export function useToggleDocumentThreadResolved(documentId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      threadId,
      nextResolved,
    }: {
      threadId: string;
      nextResolved: boolean;
    }) =>
      apiClient.post<{ threadId: string }>(
        `/documents/${documentId}/threads/${threadId}/${
          nextResolved ? "resolve" : "unresolve"
        }`,
        {}
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: documentCommentKeys.list(documentId),
      });
    },
  });
}

/**
 * Participant-resolve permission (FEA-4092): the thread author or anyone who
 * replied to it may resolve an open thread. Mirrors the server-side rule so the
 * resolve control is only offered to an actor the route would accept. `null`
 * viewer (unresolved current user) can never resolve.
 */
export function canResolveDocumentThread(
  thread: CommentThreadItem,
  viewerId: string | null | undefined
): boolean {
  if (!viewerId) {
    return false;
  }
  return thread.participantIds.includes(viewerId);
}

/**
 * Reopen permission (FEA-3950, unchanged by FEA-4092): only the thread author
 * may reopen a resolved thread — reopen stays author-only even though resolve is
 * participant-scoped. Mirrors the server-side rule.
 */
export function canReopenDocumentThread(
  thread: CommentThreadItem,
  viewerId: string | null | undefined
): boolean {
  return Boolean(viewerId) && thread.authorId === viewerId;
}

/**
 * Maps a persisted comment thread to the presentational `CommentThreadItem`
 * the rail renders. The thread's first comment is the root body; any later
 * comments render as flat replies. `participantIds` is the author plus every
 * replier's author id — the set the participant-resolve rule checks against.
 */
function toCommentThreadItem(
  thread: CommentThreadWithComments
): CommentThreadItem {
  const [root, ...rest] = thread.comments;
  const rootAuthor = root?.author ?? null;
  const authorId = thread.createdById ?? root?.authorId ?? null;

  const participantIds = new Set<string>();
  if (authorId) {
    participantIds.add(authorId);
  }
  for (const comment of thread.comments) {
    if (comment.authorId) {
      participantIds.add(comment.authorId);
    }
  }

  return {
    // The reply/resolve/reopen routes resolve the URL segment as the thread's
    // Liveblocks `externalId` (via `organizationId_externalId`), NOT the Prisma
    // row id — so the action id the rail sends back must be `externalId`, or
    // every mutation 404s. Fall back to the row id only when a thread has no
    // externalId (defensive; Liveblocks-backed document threads always carry
    // one), keeping a stable React key either way.
    id: thread.externalId ?? thread.id,
    authorId,
    status: thread.status,
    resolvedByName: thread.resolvedBy
      ? getUserDisplayName(thread.resolvedBy)
      : null,
    participantIds: [...participantIds],
    author: {
      name: rootAuthor ? getUserDisplayName(rootAuthor) : "Unknown",
      avatarUrl: rootAuthor?.avatarUrl,
    },
    body: root?.plainText ?? "",
    createdAt: (root?.createdAt ?? thread.createdAt).toISOString(),
    replies: rest.map((reply) => ({
      id: reply.id,
      authorId: reply.authorId,
      author: {
        name: reply.author ? getUserDisplayName(reply.author) : "Unknown",
        avatarUrl: reply.author?.avatarUrl,
      },
      body: reply.plainText ?? "",
      createdAt: reply.createdAt.toISOString(),
    })),
  };
}

/**
 * True when a thread is the unanchored, document-level kind the bottom Comments
 * composer represents. Anchored (in-document selection) threads are excluded so
 * the list matches what this surface can create. Mirrors the web feed's anchor
 * inference: an explicit/validated `metadata.anchorStatus` wins, else a present
 * `metadata.anchorPreview` implies anchored, else (no signal) treat as
 * artifact-level.
 */
function isArtifactLevelThread(thread: CommentThreadWithComments): boolean {
  const anchorStatus =
    resolveAnchorStatusKernel({
      anchorStatus: thread.metadata?.anchorStatus,
      anchorPreview: thread.metadata?.anchorPreview,
    }) ?? DocumentThreadAnchorStatus.ArtifactLevel;
  return anchorStatus === DocumentThreadAnchorStatus.ArtifactLevel;
}
