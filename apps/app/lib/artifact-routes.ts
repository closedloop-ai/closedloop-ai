import { getRoutePrefixForSubtype } from "@repo/api/src/types/artifact";
import type { ProjectArtifact } from "@/types/teams";

/**
 * Get the route to navigate to for viewing/editing an artifact.
 * PRDs and Implementation Plans link to their existing editor pages using documentSlug.
 */
export function getArtifactRoute(artifact: ProjectArtifact): string | null {
  // Document subtypes with slug-based routes
  const routePrefix = getRoutePrefixForSubtype(artifact.subtype);
  if (routePrefix) {
    return artifact.documentSlug
      ? `/${routePrefix}/${artifact.documentSlug}`
      : null;
  }

  // Link-based artifact types
  switch (artifact.subtype) {
    case "DESIGNS":
    case "BRANCH":
      return artifact.link || null;
    default:
      return null;
  }
}
