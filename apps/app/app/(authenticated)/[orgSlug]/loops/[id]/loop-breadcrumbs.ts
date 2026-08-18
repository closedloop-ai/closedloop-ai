import type { DocumentDetail } from "@repo/api/src/types/document";
import {
  getDocumentRoute,
  withOrgSlug,
} from "@repo/app/documents/lib/document-navigation";
import type { BreadcrumbEntry } from "@/app/(authenticated)/components/header";

/**
 * ISS-4477: the "Loops" list concept is retired from nav & UI, so the loop
 * detail's former "Loops" list crumb is gone. The loop's producing document/plan
 * is the only real parent — and how the user actually reached this run — so crumb
 * it as the parent (the Header treats the second-to-last crumb as the back path)
 * with the loop's own label as the leaf.
 *
 * The parent crumb is added only when the producing document is loaded AND
 * routable (`getDocumentRoute` returns a route): a document-less/legacy loop, or
 * one whose document has no routable subtype, degrades to a single leaf crumb
 * rather than a dead crumb that links nowhere.
 */
export function buildLoopBreadcrumbs({
  orgSlug,
  breadcrumbArtifact,
  breadcrumbLabel,
}: {
  orgSlug: string;
  breadcrumbArtifact: DocumentDetail | undefined;
  breadcrumbLabel: string;
}): BreadcrumbEntry[] {
  const leaf: BreadcrumbEntry = { label: breadcrumbLabel };
  if (!breadcrumbArtifact) {
    return [leaf];
  }
  const parentRoute = withOrgSlug(
    orgSlug,
    getDocumentRoute(breadcrumbArtifact)
  );
  if (!parentRoute) {
    return [leaf];
  }
  return [{ label: breadcrumbArtifact.title, href: parentRoute }, leaf];
}
