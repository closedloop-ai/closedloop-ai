import type { ProjectArtifact, ProjectArtifactSubtype } from "@/types/teams";

/**
 * Subtypes that support internal navigation to an editor/detail page.
 */
export const NAVIGABLE_SUBTYPES = new Set<ProjectArtifactSubtype>([
  "PRD",
  "IMPLEMENTATION_PLAN",
  "IMPLEMENTATION_STRATEGY",
  "ISSUE",
  "BUG",
]);

export function isNavigableArtifact(artifact: ProjectArtifact): boolean {
  return NAVIGABLE_SUBTYPES.has(artifact.subtype);
}

export function isExternalLink(artifact: ProjectArtifact): boolean {
  switch (artifact.subtype) {
    case "DESIGNS":
      return artifact.link?.startsWith("http") ?? false;
    case "BRANCH":
      return true;
    default:
      return false;
  }
}

/**
 * Get the route to navigate to for viewing/editing an artifact.
 * PRDs and Implementation Plans link to their existing editor pages using documentSlug.
 */
export function getArtifactRoute(artifact: ProjectArtifact): string | null {
  switch (artifact.subtype) {
    case "PRD":
      return artifact.documentSlug ? `/prds/${artifact.documentSlug}` : null;
    case "IMPLEMENTATION_PLAN":
    case "IMPLEMENTATION_STRATEGY":
      return artifact.documentSlug
        ? `/implementation-plans/${artifact.documentSlug}`
        : null;
    case "ISSUE":
    case "BUG":
      return artifact.documentSlug ? `/issues/${artifact.documentSlug}` : null;
    case "DESIGNS":
    case "BRANCH":
      return artifact.link || null;
    case "PROJECT_BRIEF":
    case "TEMPLATE":
      return null;
    default:
      return null;
  }
}
