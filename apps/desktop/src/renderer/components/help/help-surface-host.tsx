/**
 * ISS-10005 — the desktop half of the shared Help surface: transport, routing,
 * and the one thing the surface cannot own.
 *
 * Everything here is a host-boundary seam: four read-only main-process IPC calls
 * over a snapshot shipped inside the app (no browser analogue), the
 * `?page=&heading=` deep link through the desktop hash router, and
 * `slugifyHeading` — which stays because `apps/desktop/test/docs-slug-parity.test.ts`
 * holds it byte-for-byte against the generator that persisted those anchors.
 *
 * Everything else is `HelpSurfaceV2`'s.
 */
import { HelpSurfaceV2 } from "@repo/app/help/components/help-surface-v2";
import type { DocsHelpSource } from "@repo/app/help/lib/docs-help-source";
import { DEFAULT_DOCS_SITE_URL } from "../../../shared/docs-help-contract";
import { DESKTOP_DOCS_CORPUS_COPY } from "./desktop-docs-corpus-copy";
import { slugifyHeading } from "./help-slug";
import { useDocsHelp } from "./use-docs-help";
import { useHelpDeepLinkTarget } from "./use-help-deep-link-target";

export function HelpSurfaceHost() {
  const initialTarget = useHelpDeepLinkTarget();
  const docsHelp = useDocsHelp({ initialTarget });

  const source: DocsHelpSource = {
    bundleStatus: docsHelp.bundleState,
    docsSiteUrl: docsHelp.status?.docsSiteUrl ?? DEFAULT_DOCS_SITE_URL,
    isSearching: docsHelp.isSearching,
    navGroups: docsHelp.navGroups,
    onHeadingHandled: docsHelp.clearPendingHeadingSlug,
    onSearchQueryChange: docsHelp.setSearchQuery,
    page: docsHelp.pageState,
    pendingHeadingSlug: docsHelp.pendingHeadingSlug,
    searchFailed: docsHelp.searchFailed,
    searchHits: docsHelp.searchHits,
    searchQuery: docsHelp.searchQuery,
    selectPage: docsHelp.selectPage,
    selectedPath: docsHelp.selectedPath,
  };

  return (
    <HelpSurfaceV2
      corpusCopy={DESKTOP_DOCS_CORPUS_COPY}
      slugifyHeading={slugifyHeading}
      source={source}
    />
  );
}
