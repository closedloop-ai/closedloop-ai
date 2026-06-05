import { ArtifactType } from "@repo/api/src/types/artifact";

/**
 * Get the detail page URL for an artifact given its type and slug.
 * Returns null if the type has no detail page.
 */
export function getArtifactDetailUrl(
  type: ArtifactType,
  slug: string
): string | null {
  switch (type) {
    case ArtifactType.Prd:
      return `/prds/${slug}`;
    case ArtifactType.ImplementationPlan:
      return `/implementation-plans/${slug}`;
    default:
      return null;
  }
}
