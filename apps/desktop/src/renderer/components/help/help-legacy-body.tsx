/**
 * The two-pane Help body PRD-555 M2 shipped, unchanged in behaviour and kept as
 * the flag-OFF sibling of `HelpSurfaceV2` (ISS-10005).
 *
 * It composes the same shared panes and state copy, so the branches cannot drift
 * on how a doc page reads. What it lacks is the surface's own root and layout.
 *
 * It reads BOTH payloads through the same guards, and that is not a
 * nice-to-have: an unguarded `group.pages.map` unwinds the whole renderer, and
 * an unguarded page hands `renderBody ?? body` straight to the markdown
 * pipeline, where a non-nullish non-string throws (davetho review). This body
 * used to skip `readReaderPage`, so a corrupt or version-skewed page took down
 * the Help route on the DEFAULT branch — the one every flag-off user is on.
 *
 * That is why the malformed notice is shared rather than left to the surface:
 * "this branch shows one fewer notice" is a fair difference between the two,
 * and "this branch crashes" is not.
 */
import { HelpNavPane } from "@repo/app/help/components/help-nav-pane";
import {
  HelpReader,
  HelpReaderLoading,
  HelpReaderMalformed,
  HelpReaderMissing,
  HelpReaderUnavailable,
} from "@repo/app/help/components/help-reader";
import {
  HelpBundleUnavailable,
  HelpSurfaceNavSkeleton,
} from "@repo/app/help/components/help-surface-v2";
import {
  readNavGroups,
  readReaderPage,
} from "@repo/app/help/lib/docs-help-payload-guard";
import { DocsHelpBundleStatus } from "@repo/app/help/lib/docs-help-source";
import { DEFAULT_DOCS_SITE_URL } from "../../../shared/docs-help-contract";
import { DESKTOP_DOCS_CORPUS_COPY } from "./desktop-docs-corpus-copy";
import { slugifyHeading } from "./help-slug";
import { useDocsHelp } from "./use-docs-help";
import { useHelpDeepLinkTarget } from "./use-help-deep-link-target";

export function HelpLegacyBody() {
  const initialTarget = useHelpDeepLinkTarget();

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
    searchFailed,
  } = useDocsHelp({ initialTarget });

  const docsSiteUrl = status?.docsSiteUrl ?? DEFAULT_DOCS_SITE_URL;
  // Read ONCE, and the refusal count is kept rather than thrown away (whitlockk,
  // tamsinb review). This body used to call `readNavGroups(...).groups` inline
  // and pass `refusedGroups={0}` beside it, so a malformed group was dropped
  // from the tree and the pane then told the reader that nothing was missing —
  // on the DEFAULT branch, which is what every flag-off user sees.
  const nav = readNavGroups(navGroups);

  if (bundleState === DocsHelpBundleStatus.Loading) {
    return <HelpLegacyLoading />;
  }

  if (bundleState === DocsHelpBundleStatus.Unavailable) {
    return <HelpLegacyUnavailable docsSiteUrl={docsSiteUrl} />;
  }

  // The OFF branch keeps its pre-ISS-10005 rendering exactly. `useDocsHelp` used
  // to answer `unavailable` for an available-but-unbrowsable snapshot, which is
  // what put this body here; that collapse moved out of the hook (whitlockk review)
  // so the SURFACE can tell a refused tree from an empty one, and the decision
  // lives here instead — where it only speaks for this body.
  if (nav.groups.length === 0) {
    return <HelpLegacyUnavailable docsSiteUrl={docsSiteUrl} />;
  }

  return (
    <div className="flex h-full min-h-0 w-full">
      <HelpNavPane
        docsSiteUrl={docsSiteUrl}
        isSearching={isSearching}
        navEmptyDetail={DESKTOP_DOCS_CORPUS_COPY.navEmptyDetail}
        navGroups={nav.groups}
        onSearchQueryChange={setSearchQuery}
        onSelect={selectPage}
        refusedGroups={nav.refusedGroups}
        searchFailed={searchFailed}
        searchHits={searchHits}
        searchQuery={searchQuery}
        selectedPath={selectedPath}
        treeUnreadable={nav.treeUnreadable}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {pageState.kind === "found" ? (
          <HelpLegacyReader
            docsSiteUrl={docsSiteUrl}
            onHeadingHandled={clearPendingHeadingSlug}
            page={pageState.page}
            pendingHeadingSlug={pendingHeadingSlug}
          />
        ) : null}
        {pageState.kind === "loading" ? <HelpReaderLoading /> : null}
        {pageState.kind === "missing" ? (
          <HelpReaderMissing
            detail={DESKTOP_DOCS_CORPUS_COPY.pageMissingDetail}
            docsSiteUrl={docsSiteUrl}
          />
        ) : null}
        {/* ISS-10044. Shared with the surface branch for the reason the
            malformed notice is: a branch that renders one fewer state is a fair
            difference between the two, and a branch that renders a BLANK pane
            where the other explains itself is not. */}
        {pageState.kind === "error" ? (
          <HelpReaderUnavailable docsSiteUrl={docsSiteUrl} />
        ) : null}
      </div>
    </div>
  );
}

function HelpLegacyLoading() {
  return (
    <div aria-busy className="flex h-full min-h-0 w-full">
      <HelpSurfaceNavSkeleton />
      <HelpReaderLoading />
    </div>
  );
}

function HelpLegacyUnavailable({
  docsSiteUrl,
}: Readonly<{ docsSiteUrl: string }>) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <HelpBundleUnavailable
        detail={DESKTOP_DOCS_CORPUS_COPY.corpusUnavailableDetail}
        docsSiteUrl={docsSiteUrl}
        title={DESKTOP_DOCS_CORPUS_COPY.corpusUnavailableTitle}
      />
    </div>
  );
}

/**
 * The reader, behind the same page guard `HelpSurfaceV2` uses. Split out so the
 * read happens ONCE — calling `readReaderPage` twice to branch on it is how the
 * two calls drift.
 */
function HelpLegacyReader({
  docsSiteUrl,
  onHeadingHandled,
  page,
  pendingHeadingSlug,
}: Readonly<{
  docsSiteUrl: string;
  onHeadingHandled: () => void;
  page: Parameters<typeof readReaderPage>[0];
  pendingHeadingSlug: string | null;
}>) {
  const readable = readReaderPage(page);
  if (readable === null) {
    return <HelpReaderMalformed docsSiteUrl={docsSiteUrl} />;
  }
  return (
    <HelpReader
      docsSiteUrl={docsSiteUrl}
      onHeadingHandled={onHeadingHandled}
      page={readable}
      pendingHeadingSlug={pendingHeadingSlug}
      slugifyHeading={slugifyHeading}
    />
  );
}
