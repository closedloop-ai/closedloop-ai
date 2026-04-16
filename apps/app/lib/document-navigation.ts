import { type Document, DocumentType } from "@repo/api/src/types/document";
import type { Feature } from "@repo/api/src/types/feature";

const FEATURE_ROUTE_PREFIX = "features";

/**
 * Artifact types that support internal navigation to an editor/detail page.
 */
export const NAVIGABLE_TYPES = new Set<DocumentType>([
  DocumentType.Prd,
  DocumentType.ImplementationPlan,
]);

export function isNavigableDocument(artifact: Document): boolean {
  return NAVIGABLE_TYPES.has(artifact.type);
}

/**
 * Get the route to navigate to for viewing/editing an artifact.
 * PRDs and Implementation Plans link to their editor pages using slug.
 */
export function getDocumentRoute(artifact: Document): string | null {
  switch (artifact.type) {
    case DocumentType.Prd:
      return `/prds/${artifact.slug}`;
    case DocumentType.ImplementationPlan:
      return `/implementation-plans/${artifact.slug}`;
    default:
      return null;
  }
}

/**
 * Get the route to navigate to for viewing/editing a feature.
 */
export function getFeatureRoute(feature: Feature): string {
  return `/${FEATURE_ROUTE_PREFIX}/${feature.slug}`;
}
