import type { Priority } from "@repo/api/src/types/common";
import { patchCachedArtifactField } from "./patch-cached-artifact-field";

/**
 * ISS-10332 — the optimistic half of a single-artifact priority write, over
 * whatever list, page-data or detail payload the query cache holds.
 *
 * The walk itself is {@link patchCachedArtifactField}, shared with the session
 * rename since ISS-8718; everything that walk documents about shape-agnostic
 * matching, never inventing an absent key, and returning the same reference on
 * a miss holds here unchanged. This wrapper names the field so a caller cannot
 * pass the wrong one.
 */
export function patchCachedArtifactPriority<T>(
  value: T,
  artifactId: string,
  priority: Priority | null
): T {
  return patchCachedArtifactField(value, artifactId, "priority", priority);
}
