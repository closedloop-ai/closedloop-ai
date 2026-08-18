/**
 * Shared, pure derivation of a document comment thread's author and participant
 * set from its projected `createdById` + comment authors. Single source of truth
 * for the FEA-4092 participant-resolve rule so the REST guard
 * (`service/document-thread-mutations.ts`) and the Liveblocks webhook guard
 * (`service.ts` → `webhooks/liveblocks/handlers.ts`) cannot drift.
 *
 * `authorId` is the thread creator: `createdById` when the create webhook has
 * populated it, else the oldest comment's author (callers pass comments ordered
 * oldest-first). `null` when neither is available, so an author-only check fails
 * closed. `participantIds` is the author plus every comment author on the thread;
 * an empty set fails a participant check closed.
 */
export type ThreadAuthorship = {
  authorId: string | null;
  participantIds: Set<string>;
};

/**
 * The minimal projected thread shape needed to derive authorship. Comments must
 * be ordered oldest-first so `comments[0]` is the author fallback.
 */
export type ThreadAuthorshipInput = {
  createdById: string | null;
  comments: { authorId: string }[];
};

export function deriveThreadAuthorship(
  thread: ThreadAuthorshipInput
): ThreadAuthorship {
  const authorId = thread.createdById ?? thread.comments[0]?.authorId ?? null;
  const participantIds = new Set<string>();
  if (authorId !== null) {
    participantIds.add(authorId);
  }
  for (const comment of thread.comments) {
    if (comment.authorId) {
      participantIds.add(comment.authorId);
    }
  }
  return { authorId, participantIds };
}

/**
 * Fold the participant identities carried on a freshly-fetched provider thread
 * into an already-derived authorship result, without changing `authorId`.
 *
 * The Liveblocks `threadMarkedAsResolved` webhook fetches the current provider
 * thread (`client.getThread`) before it runs the participant guard, and that
 * payload's `comments[].userId` is authoritative and immediate. The DB
 * projection it derives `participantIds` from can lag — a reply-then-resolve can
 * beat the `commentCreated` webhook that projects the reply — so the projected
 * set alone would miss a legitimate replier and reopen their valid resolution.
 * Unioning the provider's comment authors closes that gap (FEA-4092). Provider
 * comments use `userId`; a deleted comment still carries its original author, so
 * no participant is dropped by a later delete.
 */
export function unionProviderParticipants(
  authorship: ThreadAuthorship,
  providerComments: { userId: string }[]
): ThreadAuthorship {
  const participantIds = new Set(authorship.participantIds);
  for (const comment of providerComments) {
    if (comment.userId) {
      participantIds.add(comment.userId);
    }
  }
  return { authorId: authorship.authorId, participantIds };
}
