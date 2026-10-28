import { isWithinTrustedFutureBoundary } from "@/lib/trusted-timestamp";

/** What is stored for one GitHub comment, as the ordering rules read it. */
export type StoredGitHubComment = {
  commentId: string;
  threadId: string;
  /** The later of `CommentSyncState.providerUpdatedAt` and the projection's `githubUpdatedAt`. */
  key: Date | null;
  /** When the comment row was last written locally. */
  writtenAt: Date | null;
  body: string | null;
  deleted: boolean;
  /** When the deletion was recorded, set whenever `deleted` is. */
  deletedAt: Date | null;
  revision: number;
};

export const CommentWriteVerdict = {
  Apply: "apply",
  /** Equal key and identical body: a no-op. */
  Same: "same",
  RejectOlder: "reject_older",
  RejectDeleted: "reject_deleted",
  RejectFuture: "reject_future",
} as const;
export type CommentWriteVerdict =
  (typeof CommentWriteVerdict)[keyof typeof CommentWriteVerdict];

/**
 * PLN-2122 decisions 1 and 2, for one incoming comment: a key past the trusted
 * future boundary is rejected; a deleted comment stays deleted unless a
 * revival dated after the deletion brings it back (a complete list read after
 * it, or a review body an edit restored); an older key is ignored; an equal
 * key with an identical body is a no-op; an equal key with a different body is applied
 * (`pull_request_review` `edited` keeps `submitted_at`), unless it comes from a
 * list read before the stored comment was last written, or is the body as
 * first submitted, whose body is then the older one.
 */
export function decideCommentWrite(input: {
  stored: StoredGitHubComment | null;
  incomingKey: Date;
  incomingBody: string;
  reviveDeletedBefore: Date | null;
  /** When the incoming comment's list was read; null for a webhook. */
  listedAt: Date | null;
  /**
   * The incoming body is the first version (a review's `submitted` delivery):
   * a different body stored at the same key can only be a later edit's.
   */
  firstVersion?: boolean;
  now: Date;
}): CommentWriteVerdict {
  if (!isWithinTrustedFutureBoundary(input.incomingKey, input.now)) {
    return CommentWriteVerdict.RejectFuture;
  }
  const { stored } = input;
  if (!stored) {
    return CommentWriteVerdict.Apply;
  }
  if (stored.deleted) {
    return isDeletedBefore(stored, input.reviveDeletedBefore)
      ? CommentWriteVerdict.Apply
      : CommentWriteVerdict.RejectDeleted;
  }
  if (!stored.key) {
    return CommentWriteVerdict.Apply;
  }
  const incoming = input.incomingKey.getTime();
  const current = stored.key.getTime();
  if (incoming < current) {
    return CommentWriteVerdict.RejectOlder;
  }
  if (incoming === current && stored.body === input.incomingBody) {
    return CommentWriteVerdict.Same;
  }
  if (
    incoming === current &&
    (input.firstVersion === true || isWrittenSince(stored, input.listedAt))
  ) {
    return CommentWriteVerdict.RejectOlder;
  }
  return CommentWriteVerdict.Apply;
}

export function isAcceptedVerdict(verdict: CommentWriteVerdict): boolean {
  return (
    verdict === CommentWriteVerdict.Apply ||
    verdict === CommentWriteVerdict.Same
  );
}

function isDeletedBefore(
  stored: StoredGitHubComment,
  listedAt: Date | null
): boolean {
  return Boolean(
    listedAt &&
      stored.deletedAt &&
      stored.deletedAt.getTime() < listedAt.getTime()
  );
}

/** The rejection an event reports when none of its comments was accepted. */
export function strongestRejection(
  verdicts: readonly CommentWriteVerdict[]
): CommentWriteVerdict {
  for (const verdict of [
    CommentWriteVerdict.RejectFuture,
    CommentWriteVerdict.RejectDeleted,
  ]) {
    if (verdicts.includes(verdict)) {
      return verdict;
    }
  }
  return CommentWriteVerdict.RejectOlder;
}

function isWrittenSince(
  stored: StoredGitHubComment,
  listedAt: Date | null
): boolean {
  return Boolean(
    listedAt &&
      stored.writtenAt &&
      stored.writtenAt.getTime() >= listedAt.getTime()
  );
}
