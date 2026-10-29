export const CommentAnchorKind = {
  Artifact: "artifact",
  Text: "text",
  Trace: "trace",
  Code: "code",
  /** Reserved for prototype annotations: it validates, but no source policy allows it yet. */
  Prototype: "prototype",
} as const;
export type CommentAnchorKind =
  (typeof CommentAnchorKind)[keyof typeof CommentAnchorKind];
