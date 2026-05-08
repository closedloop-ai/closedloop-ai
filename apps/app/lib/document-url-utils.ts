import { DocumentType } from "@repo/api/src/types/document";

/**
 * Get the detail page URL for an artifact given its type and slug.
 * Returns null if the type has no detail page.
 */
export function getDocumentDetailUrl(
  type: DocumentType,
  slug: string
): string | null {
  switch (type) {
    case DocumentType.Prd:
      return `/prds/${slug}`;
    case DocumentType.ImplementationPlan:
      return `/implementation-plans/${slug}`;
    default:
      return null;
  }
}
