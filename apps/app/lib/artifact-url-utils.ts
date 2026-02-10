/**
 * Get the detail page URL for a document artifact given its subtype and slug.
 * Returns null if the subtype has no detail page or slug is missing.
 */
export function getArtifactDetailUrl(
  subtype: string,
  documentSlug: string | null
): string | null {
  if (!documentSlug) {
    return null;
  }

  switch (subtype) {
    case "PRD":
      return `/prds/${documentSlug}`;
    case "IMPLEMENTATION_PLAN":
    case "IMPLEMENTATION_STRATEGY":
      return `/implementation-plans/${documentSlug}`;
    case "ISSUE":
    case "BUG":
      return `/issues/${documentSlug}`;
    default:
      return null;
  }
}
