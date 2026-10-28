import { z } from "zod";

/** Error codes the comment API returns; clients map them to approved copy. */
export const CommentErrorCode = {
  CapabilityDenied: "capability_denied",
  StaleRevision: "stale_revision",
  ClientIdConflict: "client_id_conflict",
  AnchorInvalid: "anchor_invalid",
  AnchorKindNotAllowed: "anchor_kind_not_allowed",
  ArtifactTypeNotSupported: "artifact_type_not_supported",
  NotFound: "not_found",
} as const;
export type CommentErrorCode =
  (typeof CommentErrorCode)[keyof typeof CommentErrorCode];

export const commentErrorCodeSchema = z.enum(CommentErrorCode);
