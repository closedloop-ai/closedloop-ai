/**
 * The stored link relation narrowing, moved out of `sync-source.ts`
 * (grandfathered, shrink-only) for ISS-12552 so the operation-evidence field
 * could be added without growing it.
 */
import { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link";

const ARTIFACT_REF_RELATION_VALUES = new Set<string>(
  Object.values(ArtifactRefRelation)
);

/** Narrow the stored link relation to a known `ArtifactRefRelation`, else undefined. */
export function toArtifactRefRelation(
  value: string | null
): ArtifactRefRelation | undefined {
  return value !== null && ARTIFACT_REF_RELATION_VALUES.has(value)
    ? (value as ArtifactRefRelation)
    : undefined;
}
