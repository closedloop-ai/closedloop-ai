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

export function isNavigableDocument(artifact: Pick<Document, "type">): boolean {
  return NAVIGABLE_TYPES.has(artifact.type);
}

// These resolvers return ORG-RELATIVE routes (e.g. `/prds/slug`). Callers turn
// them into absolute paths via the org seam: a React surface composes with
// `useOrgPath()`'s `buildOrgPath`, while a slug-holding caller (page/pure util)
// uses `withOrgSlug(orgSlug, route)` below. This keeps the resolvers free of the
// web-only org slug so shared/desktop code can reuse them (FEA-1510).
export function getDocumentRoute(
  artifact: Pick<Document, "type" | "slug">
): string | null {
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
 * Get the org-relative route for an Artifact wire object. Returns null for
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

/**
 * Compose an org-relative route (from the resolvers above) with an org slug.
 * For slug-holding callers — route pages and pure tree utilities that receive
 * the slug as data. React components should prefer `useOrgPath()` instead.
 * Null-safe: a null route (non-navigable artifact) stays null.
 */
export function withOrgSlug(
  orgSlug: string,
  route: string | null
): string | null {
  return route === null ? null : `/${orgSlug}${route}`;
}
