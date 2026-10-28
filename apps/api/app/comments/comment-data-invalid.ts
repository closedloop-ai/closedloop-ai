import { log } from "@repo/observability/log";

/**
 * PLN-2120 decision 8: the one structured event for comment data the server
 * cannot use. Every caller logs through {@link reportCommentDataInvalid}, so the
 * log monitor (ISS-11554) matches a single `@event` value; `reason` says which
 * check failed.
 */
export const COMMENTS_DATA_INVALID_EVENT = "comments.data_invalid";

export const CommentDataInvalidReason = {
  /** A trace thread with no stored anchor: the migration did not move it. */
  AnchorMissing: "anchor_missing",
  /** A stored anchor that does not parse, or is a newer envelope version. */
  AnchorUnparseable: "anchor_unparseable",
  /** A provider thread whose room resolves to no artifact. */
  ThreadWithoutArtifact: "thread_without_artifact",
  /** PLN-2122 decision 1: a provider ordering key past the trusted future boundary. */
  ProviderTimestampInFuture: "provider_timestamp_in_future",
  /** A provider position that is not a valid code anchor; the thread keeps its stored anchor. */
  ProviderAnchorInvalid: "provider_anchor_invalid",
} as const;
export type CommentDataInvalidReason =
  (typeof CommentDataInvalidReason)[keyof typeof CommentDataInvalidReason];

export type CommentDataInvalidReport = {
  reason: CommentDataInvalidReason;
  organizationId: string;
  threadId?: string;
  roomId?: string;
  /** The provider object the value came from, e.g. a GitHub comment id. */
  providerObjectId?: string;
};

/**
 * A Liveblocks room can outlive its deleted artifact and keep sending webhooks,
 * so an unresolvable room is expected traffic and logs at warn; the monitor
 * pages on error.
 */
const COMMENT_DATA_INVALID_LOG_LEVEL = {
  [CommentDataInvalidReason.AnchorMissing]: "error",
  [CommentDataInvalidReason.AnchorUnparseable]: "error",
  [CommentDataInvalidReason.ThreadWithoutArtifact]: "warn",
  [CommentDataInvalidReason.ProviderTimestampInFuture]: "error",
  [CommentDataInvalidReason.ProviderAnchorInvalid]: "warn",
} as const satisfies Record<CommentDataInvalidReason, "error" | "warn">;

export function reportCommentDataInvalid(
  report: CommentDataInvalidReport
): void {
  const emit =
    COMMENT_DATA_INVALID_LOG_LEVEL[report.reason] === "error"
      ? log.error
      : log.warn;
  emit(COMMENTS_DATA_INVALID_EVENT, {
    event: COMMENTS_DATA_INVALID_EVENT,
    reason: report.reason,
    organizationId: report.organizationId,
    ...(report.threadId === undefined ? {} : { threadId: report.threadId }),
    ...(report.roomId === undefined ? {} : { roomId: report.roomId }),
    ...(report.providerObjectId === undefined
      ? {}
      : { providerObjectId: report.providerObjectId }),
  });
}
