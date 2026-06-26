import { DocumentType } from "@repo/api/src/types/document";
import type { ArtifactReference } from "@repo/github/artifact-reference-parser";

/**
 * Pick the reference that owns PR/branch linkage. Plans win because they
 * semantically produce implementation PRs; otherwise the first feature ref is
 * the branch owner.
 */
export function pickPrimaryArtifactReference(
  refs: ArtifactReference[]
): ArtifactReference | undefined {
  const planRef = refs.find(
    (ref) => ref.docType === DocumentType.ImplementationPlan
  );
  if (planRef) {
    return planRef;
  }
  return refs.find((ref) => ref.docType === DocumentType.Feature);
}
