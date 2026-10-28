import { DocumentType } from "@repo/api/src/types/document";
import {
  type ArtifactReference,
  parseArtifactReferences,
} from "@repo/github/artifact-reference-parser";

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

/**
 * The reference a pull request's title and body name for linkage, or
 * undefined when they name none, in which case the delivery links nothing.
 */
export function pickPullRequestArtifactReference(pullRequest: {
  title?: string | null;
  body?: string | null;
}): ArtifactReference | undefined {
  return pickPrimaryArtifactReference(
    parseArtifactReferences(
      pullRequest.title,
      pullRequest.body,
      process.env.NEXT_PUBLIC_APP_URL
    )
  );
}
