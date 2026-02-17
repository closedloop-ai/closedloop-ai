import { type Artifact, ArtifactType } from "@repo/api/src/types/artifact";
import type { Issue } from "@repo/api/src/types/issue";

/**
 * Artifact types that support internal navigation to an editor/detail page.
 */
export const NAVIGABLE_TYPES = new Set<ArtifactType>([
  ArtifactType.Prd,
  ArtifactType.ImplementationPlan,
]);

export function isNavigableArtifact(artifact: Artifact): boolean {
  return NAVIGABLE_TYPES.has(artifact.type);
}

/**
 * Get the route to navigate to for viewing/editing an artifact.
 * PRDs and Implementation Plans link to their editor pages using slug.
 */
export function getArtifactRoute(artifact: Artifact): string | null {
  switch (artifact.type) {
    case ArtifactType.Prd:
      return `/prds/${artifact.slug}`;
    case ArtifactType.ImplementationPlan:
      return `/implementation-plans/${artifact.slug}`;
    default:
      return null;
  }
}

/**
 * Get the route to navigate to for viewing/editing an issue.
 */
export function getIssueRoute(issue: Issue): string {
  return `/issues/${issue.slug}`;
}
