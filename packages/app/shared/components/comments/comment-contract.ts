import type { CommentAnchorByKind } from "@repo/api/src/types/comment-anchor";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import type { ExternalSyncRelationship } from "./external-sync-contract";

/**
 * Canonical artifact-comment contract used by the generic shell.
 *
 * The thread workflow, persistence provider, and anchor are independent axes.
 * Artifact specializations adapt their native anchor into the shared
 * `CommentAnchor` instead of inventing a separate comment model or card anatomy.
 */

/**
 * What the preview surface captured for a comment's placement. This is a
 * local capture type, not a `CommentAnchor`: only `kind` is guaranteed, and
 * the selectors appear when the surface supplied them. Adapt it to a full
 * `CommentAnchor` at the API boundary.
 */
export type CapturedArtifactCommentAnchor = {
  [K in CommentAnchorKind]: Pick<CommentAnchorByKind[K], "kind"> &
    Partial<Omit<CommentAnchorByKind[K], "kind">>;
}[CommentAnchorKind];

export type ArtifactCommentSource = {
  provider: "native" | "liveblocks" | "github";
  externalId?: string;
  /** Present only when this record is mirrored to a user-visible external system. */
  externalSync?: ExternalSyncRelationship;
  readOnly?: boolean;
};

export type ArtifactCommentStatus = "open" | "resolved";

export function commentAnchorKind(
  anchor: CapturedArtifactCommentAnchor | undefined,
  legacyTraceRow?: number
): CommentAnchorKind {
  if (anchor) {
    return anchor.kind;
  }
  return legacyTraceRow == null
    ? CommentAnchorKind.Artifact
    : CommentAnchorKind.Trace;
}
