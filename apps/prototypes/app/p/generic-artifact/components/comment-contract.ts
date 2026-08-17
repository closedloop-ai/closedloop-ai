import type { ExternalSyncRelationship } from "./external-sync-contract";

/**
 * Canonical artifact-comment contract used by the generic shell.
 *
 * The thread workflow, persistence provider, and anchor are independent axes.
 * Artifact specializations adapt their native anchor into this union instead of
 * inventing a separate comment model or card anatomy.
 */

export type ArtifactCommentAnchor =
  | ArtifactWideCommentAnchor
  | ContentCommentAnchor
  | PrototypeCommentAnchor
  | SessionTraceCommentAnchor
  | CodeCommentAnchor;

export type ArtifactWideCommentAnchor = {
  type: "artifact";
};

export type ContentCommentAnchor = {
  type: "content";
  /** Stable block, field, or editor-node identity when the surface supplies it. */
  contentId?: string;
  fieldId?: string;
  quote?: string;
  /** Editor-native serialized range; never interpreted as viewport geometry. */
  range?: string;
};

/**
 * Durable Prototype-as-Artifact annotation anchor.
 *
 * Identity is prototypeVersionId + route + anchorId. Rectangles and normalized
 * positions are transient/diagnostic data used to paint the current overlay;
 * they are not sufficient to restore a thread. The iframe bridge resolves the
 * live DOM target and reports fresh geometry after navigation, scroll, resize,
 * or layout changes. Missing anchors remain explicitly orphaned until a person
 * carries the thread forward or re-anchors it.
 */
export type PrototypeCommentAnchor = {
  type: "prototype";
  prototypeVersionId: string;
  route: string;
  anchorId: string;
  selector?: string;
  domPath?: string;
  textContext?: string;
  normalizedPosition?: { x: number; y: number };
  originalRect?: { x: number; y: number; width: number; height: number };
  viewport?: { width: number; height: number };
  screenshotRef?: string;
  restoration: "resolved" | "orphaned" | "carried-forward";
  sourceVersionId?: string;
};

export type SessionTraceCommentAnchor = {
  type: "trace";
  sessionId?: string;
  turnId?: string;
  phaseId?: string;
  traceRow?: number;
  quote?: string;
};

export type CodeCommentAnchor = {
  type: "code";
  repository?: string;
  commitSha?: string;
  path: string;
  startLine?: number;
  endLine?: number;
  side?: "left" | "right";
  externalUrl?: string;
};

export type ArtifactCommentSource = {
  provider: "native" | "liveblocks" | "github";
  externalId?: string;
  /** Present only when this record is mirrored to a user-visible external system. */
  externalSync?: ExternalSyncRelationship;
  readOnly?: boolean;
};

export type ArtifactCommentStatus = "open" | "resolved";

export function commentAnchorType(
  anchor: ArtifactCommentAnchor | undefined,
  legacyTraceRow?: number
): ArtifactCommentAnchor["type"] {
  if (anchor) {
    return anchor.type;
  }
  return legacyTraceRow == null ? "artifact" : "trace";
}
