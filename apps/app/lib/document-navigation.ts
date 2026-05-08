import { type Artifact, ArtifactType } from "@repo/api/src/types/artifact";
import {
  type Document,
  DocumentType,
  getRoutePrefixForType,
} from "@repo/api/src/types/document";

const FEATURE_ROUTE_PREFIX = "features";

/**
 * Artifact types that support internal navigation to an editor/detail page.
 */
export const NAVIGABLE_TYPES = new Set<DocumentType>([
  DocumentType.Prd,
  DocumentType.ImplementationPlan,
  DocumentType.Feature,
]);

export function isNavigableDocument(artifact: Document): boolean {
  return NAVIGABLE_TYPES.has(artifact.type);
}

export function getDocumentRoute(artifact: Document): string | null {
  switch (artifact.type) {
    case DocumentType.Prd:
      return `/prds/${artifact.slug}`;
    case DocumentType.ImplementationPlan:
      return `/implementation-plans/${artifact.slug}`;
    case DocumentType.Feature:
      return `/${FEATURE_ROUTE_PREFIX}/${artifact.slug}`;
    default:
      return null;
  }
}

/**
 * Get the route to navigate to for viewing/editing a feature-typed document.
 */
export function getFeatureRoute(feature: { slug: string }): string {
  return `/${FEATURE_ROUTE_PREFIX}/${feature.slug}`;
}

/**
 * Get the route to navigate to for an Artifact wire object. Returns null for
 * non-Document artifacts and for documents without a slug or routable subtype.
 */
export function getArtifactRoute(artifact: Artifact): string | null {
  if (artifact.type !== ArtifactType.Document) {
    return null;
  }
  if (!(artifact.slug && artifact.subtype)) {
    return null;
  }
  const routePrefix = getRoutePrefixForType(artifact.subtype);
  return routePrefix ? `/${routePrefix}/${artifact.slug}` : null;
}
