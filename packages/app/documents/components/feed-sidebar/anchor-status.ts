import type { ThreadData } from "@liveblocks/client";

export type EffectiveAnchorStatus = "anchored" | "floating" | "artifact-level";

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
 * The `"floating"` state is only ever set explicitly — there is no legacy
 * data with a floating concept until the Cross-Version Comment Persistence
 * feature ships its conversion pass.
 */
export function deriveAnchorStatus(thread: ThreadData): EffectiveAnchorStatus {
  const explicit = thread.metadata.anchorStatus;
  if (explicit !== undefined) {
    return explicit;
  }
  return thread.metadata.anchorPreview === undefined
    ? "artifact-level"
    : "anchored";
}
