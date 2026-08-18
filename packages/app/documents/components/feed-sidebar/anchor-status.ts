import type { ThreadData } from "@liveblocks/client";
import {
  DocumentThreadAnchorStatus,
  type DocumentThreadAnchorStatus as DocumentThreadAnchorStatusType,
  resolveAnchorStatusKernel,
} from "@repo/api/src/types/comment";

export type EffectiveAnchorStatus = DocumentThreadAnchorStatusType;

/**
 * Computes the effective anchor status for a thread, preferring the
 * explicit `metadata.anchorStatus` field (set on new threads by the
 * FloatingComposer wrapper and the artifact-level composer) and falling
 * back to the legacy implicit signal for threads created before the
 * field existed:
 *
 * - `anchorPreview` set → treat as `"anchored"`
 * - `anchorPreview` unset → treat as `"artifact-level"`
 *
 * The core explicit-status / `anchorPreview` inference is the shared
 * {@link resolveAnchorStatusKernel}; the web feed layers its own
 * `artifact-level` fallback on the kernel's neutral (`null`) result.
 *
 * The `"floating"` state is only ever set explicitly — there is no legacy
 * data with a floating concept until the Cross-Version Comment Persistence
 * feature ships its conversion pass.
 */
export function deriveAnchorStatus(thread: ThreadData): EffectiveAnchorStatus {
  return (
    resolveAnchorStatusKernel({
      anchorStatus: thread.metadata.anchorStatus,
      anchorPreview: thread.metadata.anchorPreview,
    }) ?? DocumentThreadAnchorStatus.ArtifactLevel
  );
}
