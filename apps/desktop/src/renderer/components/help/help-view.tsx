/**
 * Two-pane in-app Help view (FEA-3844 / PRD-555 M2).
 *
 * Left pane: the `meta.json` nav tree (groups → pages) + a search box over the
 * M1 local index. Right pane: the selected doc page rendered from its bundled
 * body via the design-system `MarkdownContent` primitive, with search hits that
 * matched a heading deep-linking to that section. All data comes from the
 * read-only M1 `docs-help` IPC (`window.desktopApi.docsHelp.*`); nothing is
 * mutated.
 *
 * Gated on the `docsHelp` Labs flag AND (ISS-5037) the Labs container gate
 * above it: `App.tsx` hides the Help nav id when either is off, and this view
 * renders null as a defense-in-depth guard so a direct `#/help` hash can't
 * reach it either (mirrors `AgentsView`).
 *
 * States handled: loading (bundle not yet read), unavailable (empty/failed
 * bundle → dark with a "view online" escape hatch), page loading, and page
 * not-found.
 */
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { EmptyState } from "@closedloop-ai/design-system/components/ui/empty-state";
import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { BookOpenIcon, ExternalLinkIcon } from "lucide-react";
import { useMemo } from "react";
import { DOCS_HELP_VIEW_ONLINE_LABEL } from "../../../shared/docs-help-contract";
import {
  HELP_HEADING_PARAM,
  HELP_PAGE_PARAM,
} from "../../navigation/route-table";
import { useDocsHelpSurfaceEnabled } from "../../navigation/use-nav-gates";
import { HelpNavPane } from "./help-nav-pane";
import {
  HelpReader,
  HelpReaderLoading,
  HelpReaderMissing,
} from "./help-reader";
import { type DocsHelpInitialTarget, useDocsHelp } from "./use-docs-help";

/** Fallback docs URL used before `status` resolves (matches the bundle default). */
const DEFAULT_DOCS_SITE_URL = "https://closedloop.ai/docs";

export function HelpView() {
  const flagOn = useDocsHelpSurfaceEnabled();
  // Defense-in-depth: the nav id is hidden when the Docs/Help flag or the
  // ISS-5037 Labs container gate above it is off (App.tsx), but a direct #/help
  // hash could still mount this — render null so it stays dark.
  if (!flagOn) {
    return null;
  }
  return <HelpViewInner />;
}

function HelpViewInner() {
  // The command-palette Docs group (FEA-3845 / PRD-555 M3) opens a specific page
  // by navigating to `/help?page=…&heading=…`; read those params and feed them to
  // the hook's initial-target seam so Enter lands on the picked page/section. A
  // repeat pick carries a distinct query string → a fresh target object → the
  // hook re-selects and re-scrolls even when that page is already open.
  const searchParams = useSearchParamsValue();
  const targetPath = searchParams.get(HELP_PAGE_PARAM);
  const targetHeading = searchParams.get(HELP_HEADING_PARAM);
  const initialTarget = useMemo<DocsHelpInitialTarget | null>(
    () =>
      targetPath
        ? { path: targetPath, headingSlug: targetHeading ?? undefined }
        : null,
    [targetPath, targetHeading]
  );

  const {
    bundleState,
    status,
    navGroups,
    selectedPath,
    pageState,
    selectPage,
    pendingHeadingSlug,
    clearPendingHeadingSlug,
    searchQuery,
    setSearchQuery,
    searchHits,
    isSearching,
  } = useDocsHelp({ initialTarget });

  const docsSiteUrl = status?.docsSiteUrl ?? DEFAULT_DOCS_SITE_URL;

  if (bundleState === "loading") {
    return <HelpViewLoading />;
  }

  if (bundleState === "unavailable") {
    return <HelpViewUnavailable docsSiteUrl={docsSiteUrl} />;
  }

  return (
    <div className="flex h-full min-h-0 w-full">
      <HelpNavPane
        isSearching={isSearching}
        navGroups={navGroups}
        onSearchQueryChange={setSearchQuery}
        onSelect={selectPage}
        searchHits={searchHits}
        searchQuery={searchQuery}
        selectedPath={selectedPath}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {pageState.kind === "found" ? (
          <HelpReader
            docsSiteUrl={docsSiteUrl}
            onHeadingHandled={clearPendingHeadingSlug}
            page={pageState.page}
            pendingHeadingSlug={pendingHeadingSlug}
          />
        ) : null}
        {pageState.kind === "loading" ? <HelpReaderLoading /> : null}
        {pageState.kind === "missing" ? (
          <HelpReaderMissing docsSiteUrl={docsSiteUrl} />
        ) : null}
      </div>
    </div>
  );
}

function HelpViewLoading() {
  return (
    <div aria-hidden className="flex h-full min-h-0 w-full">
      <div className="flex w-72 shrink-0 flex-col gap-2 border-border/60 border-r p-3">
        <Skeleton className="mb-2 h-9 w-full" />
        {Array.from({ length: 8 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows.
          <Skeleton className="h-6 w-full" key={index} />
        ))}
      </div>
      <HelpReaderLoading />
    </div>
  );
}

function HelpViewUnavailable({
  docsSiteUrl,
}: Readonly<{ docsSiteUrl: string }>) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState
        action={
          <Button asChild size="sm" variant="outline">
            <a href={docsSiteUrl} rel="noreferrer" target="_blank">
              <ExternalLinkIcon aria-hidden className="size-3.5" />
              {DOCS_HELP_VIEW_ONLINE_LABEL}
            </a>
          </Button>
        }
        description="The bundled documentation snapshot isn't available in this build. You can still read the latest docs online."
        icon={BookOpenIcon}
        title="Docs aren't available offline"
      />
    </div>
  );
}
