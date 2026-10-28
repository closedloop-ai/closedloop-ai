import { DOCUMENT_ROUTE_PREFIX } from "@repo/api/src/types/document";
import { isValidVersionNumber } from "@repo/api/src/types/document-version";
import type { Metadata } from "next";
import { resolveOgMetadata } from "@/lib/og-metadata";
import { DocumentEditorContainer } from "./document-editor-container";

/**
 * The one detail page for every document (ISS-12855, PRD-799 G-01). The legacy
 * per-type routes (`/prds/:slug`, `/implementation-plans/:slug`,
 * `/issues/:slug`, `/features/:slug`) redirect here in the proxy. The editor is
 * chosen by the loaded document's type in `DocumentDetailEditor`, which also
 * renders not-found for a Template.
 */

type DocumentPageProps = {
  params: Promise<{ orgSlug: string; slug: string }>;
  searchParams: Promise<{ version?: string }>;
};

export async function generateMetadata({
  params,
}: DocumentPageProps): Promise<Metadata> {
  const { orgSlug, slug } = await params;
  return resolveOgMetadata(`${orgSlug}/${DOCUMENT_ROUTE_PREFIX}/${slug}`);
}

/** A `?version` must be a whole positive integer — reject "2junk", "2.5", etc. */
const VERSION_PARAM_PATTERN = /^\d+$/;

/**
 * Parse a `?version` search param to a positive integer, or `undefined` when it
 * is absent or invalid. Validation matches the API's whole-number/integer
 * contract: `parseInt` alone would accept "2junk" and "2.5" as 2, so the string
 * is first checked to be all digits. An invalid value falls back to the latest
 * version rather than 404ing, on every document type (PLN-2217 Q-002, Kerensa
 * Whitlock, 2026-10-21).
 */
function parseVersionParam(version?: string): number | undefined {
  if (!(version && VERSION_PARAM_PATTERN.test(version))) {
    return;
  }
  const parsed = Number.parseInt(version, 10);
  if (!isValidVersionNumber(parsed)) {
    return;
  }
  return parsed;
}

export default async function DocumentPage({
  params,
  searchParams,
}: Readonly<DocumentPageProps>) {
  const { slug } = await params;
  const { version } = await searchParams;
  const versionNumber = parseVersionParam(version);
  // Key by slug + resolved version so navigating between ?version values on
  // the same slug remounts the container and re-seeds its internal version
  // selector from the URL (apps/app/AGENTS.md).
  return (
    <DocumentEditorContainer
      key={`${slug}:${versionNumber ?? "latest"}`}
      slug={slug}
      version={versionNumber}
    />
  );
}
