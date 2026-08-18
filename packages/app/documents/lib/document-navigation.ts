import { type Artifact, ArtifactType } from "@repo/api/src/types/artifact";
import { parseTypedArtifactSlug } from "@repo/api/src/types/artifact-slug-parse";
import {
  type Document,
  DocumentType,
  getRoutePrefixForType,
} from "@repo/api/src/types/document";

/**
 * Artifact types that support internal navigation to an editor/detail page.
 *
 * DOC routes to `/documents/[slug]`, which now renders the DOC editor in place
 * (ISS-4382). Templates remain absent: they have no list/detail surface yet.
 */
export const NAVIGABLE_TYPES = new Set<DocumentType>([
  DocumentType.Prd,
  DocumentType.ImplementationPlan,
  DocumentType.Feature,
  DocumentType.Doc,
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
    // FEA-4137: the Feature artifact is now "Issue", routing under /issues/.
    // Legacy /features/[slug] links redirect there — 308 once the path already
    // carries its org prefix, 302 while the redirect still has to inject the
    // caller's (ISS-4570). Delegate to getDocumentTypeRoute so the prefix has
    // ONE source of truth (TYPE_ROUTE_PREFIX) and this switch cannot drift.
    case DocumentType.Feature:
      return getDocumentTypeRoute(artifact.type, artifact.slug);
    // ISS-4382: DOC now has a real editor at `/documents/[slug]`. Delegate to
    // getDocumentTypeRoute so the "documents" prefix stays single-sourced in
    // TYPE_ROUTE_PREFIX rather than re-inlined here.
    case DocumentType.Doc:
      return getDocumentTypeRoute(artifact.type, artifact.slug);
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
  return getDocumentTypeRoute(artifact.subtype, artifact.slug);
}

/**
 * Get the org-relative route for a linked-artifact wire shape keyed on its
 * `documentType` + `slug` (e.g. FEA-3635's `SessionLinkedArtifact`, which
 * carries `documentType` rather than the `Artifact.subtype`). Returns null when
 * the slug or documentType is missing, or when the type is not navigable (e.g.
 * Template). Single resolver so callers don't re-inline the prefix/slug join.
 */
export function getDocumentTypeRoute(
  documentType: string | null | undefined,
  slug: string | null | undefined
): string | null {
  if (!(slug && documentType)) {
    return null;
  }
  const routePrefix = getRoutePrefixForType(documentType);
  return routePrefix ? `/${routePrefix}/${slug}` : null;
}

/**
 * Human-readable label for a document type, used where a linked-artifact pill
 * must name the artifact kind (FEA-3635). Covers every {@link DocumentType}
 * member explicitly; a new subtype falls through to null (a generic label)
 * until a case is added. Null when the type is unknown/absent, so callers can
 * fall back to a generic label.
 */
export function getDocumentTypeLabel(
  documentType: DocumentType | null | undefined
): string | null {
  switch (documentType) {
    case DocumentType.Feature:
      return "Issue";
    case DocumentType.Prd:
      return "PRD";
    case DocumentType.ImplementationPlan:
      return "Plan";
    case DocumentType.Template:
      return "Template";
    case DocumentType.Doc:
      return "Document";
    default:
      return null;
  }
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

/**
 * Org-relative route for a Closedloop artifact addressed by SLUG ALONE (e.g. a
 * branch's `linkedArtifacts`, which carry only the slug embedded in the branch
 * name — no `documentType`). Derives the DocumentType from the slug's prefix via
 * the SSOT prefix map, then delegates to {@link getDocumentTypeRoute} so the
 * route-prefix join stays single-sourced. The slug's prefix is normalized to its
 * canonical (upper) case before it is embedded, so a lowercase branch-name slug
 * (`fea-1952`) yields `/issues/FEA-1952` — which matches the case-sensitive
 * by-slug lookup — not a 404-ing `/issues/fea-1952`. Returns null for a non-typed
 * slug or a prefix with no navigable route (e.g. `PRO-`/`WRK-`/`SES-`) — the
 * caller then renders the slug as a non-clickable label. Callers compose with an
 * org slug via {@link withOrgSlug} exactly as the `documentType`-bearing path does.
 */
export function getRouteForSlug(
  slug: string | null | undefined
): string | null {
  const parsed = parseTypedArtifactSlug(slug);
  return parsed
    ? getDocumentTypeRoute(parsed.documentType, parsed.canonicalSlug)
    : null;
}

/**
 * Human-readable kind label for a Closedloop artifact addressed by SLUG ALONE
 * (e.g. a branch's `linkedArtifacts`) — "Issue", "PRD", "Plan", "Document". Peer
 * of {@link getRouteForSlug}: derives the DocumentType from the slug's prefix via
 * the SSOT prefix map, then delegates to {@link getDocumentTypeLabel} so the
 * label copy stays single-sourced. Returns null for a non-typed slug or an
 * unlabelled prefix (e.g. `PRO-`/`WRK-`/`SES-`), letting the caller fall back to
 * a generic label. This lets a slug-only surface name the artifact kind instead
 * of repeating a generic "Closedloop artifact" string on every row (FEA-4292).
 */
export function getLabelForSlug(
  slug: string | null | undefined
): string | null {
  const parsed = parseTypedArtifactSlug(slug);
  return parsed ? getDocumentTypeLabel(parsed.documentType) : null;
}
