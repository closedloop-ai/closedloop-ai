"use client";

import { HelpSurfaceV2 } from "@repo/app/help/components/help-surface-v2";
import {
  firstNavigablePath,
  isSearchHitsUnreadable,
  readSearchHits,
} from "@repo/app/help/lib/docs-help-payload-guard";
import {
  DocsHelpBundleStatus,
  type DocsHelpPageState,
  type DocsHelpSource,
} from "@repo/app/help/lib/docs-help-source";
import {
  DOCS_SEARCH_DEBOUNCE_MS,
  DocsCorpusFailureReason,
  WEB_DOCS_CORPUS_COPY,
  WEB_DOCS_CORPUS_COPY_NOT_DEPLOYED,
} from "@repo/app/help/lib/web-help-contract";
import { useDebouncedValue } from "@repo/app/shared/hooks/use-debounced-value";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DocsCorpusUnavailableError,
  DocsHelpPageMissingError,
  useDocsHelpNav,
  useDocsHelpPage,
  useDocsHelpSearch,
} from "@/hooks/queries/use-docs-help";
import { slugifyHeading } from "@/lib/docs-help/docs-slug";

/**
 * ISS-10006 — the WEB host for `HelpSurfaceV2`.
 *
 * Help has no device-only capability: all four of its capabilities are docs
 * reads, and `apps/web` publishes the same corpus the desktop bundle snapshots,
 * with the same `meta.json` group/pages shape. So web mounts it WHOLE — nothing
 * here is absent, disabled or handed off, and there is no treatment to state.
 *
 * What web replaces is the transport. Desktop's is four privileged IPC calls
 * over a snapshot packed into the app; web's is three reads against its own
 * server, which parses the same corpus off the deployment. The state ladder is
 * wired to the reads rather than folded into them, because every collapse the
 * surface's contract warns about is reachable here:
 *
 * - a failed nav read is `Unavailable`, never `navGroups: []` — an empty tree
 *   tells the reader the docs set has no pages;
 * - a 404 on a page is `missing` and any other failure is `error`, because "the
 *   corpus has no such page" sends a reader online and "the read failed" sends
 *   them back;
 * - a failed search is `searchFailed`, and so is a reply the shared payload
 *   guard refuses — `[]` is the surface's "matched nothing", which is a claim
 *   about a corpus nothing searched.
 *
 * The reads are QUERIES rather than hand-rolled `fetch` in an effect: the corpus
 * is immutable for the life of a deployment, so it is cached instead of re-read
 * on every mount, and a superseded response cannot land on the pane because a
 * different query is a different key.
 */
export function WebHelpSurfaceHost({ docsSiteUrl }: { docsSiteUrl: string }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [pendingHeadingSlug, setPendingHeadingSlug] = useState<string | null>(
    null
  );
  const [searchQuery, setSearchQuery] = useState("");

  const nav = useDocsHelpNav();
  const pageQuery = useDocsHelpPage(selectedPath);
  // Debounced into the KEY, so the query in flight is always the one the box
  // shows. A per-keystroke key would issue one server-side scan of 155 pages
  // per character typed. Keeping the PREVIOUS query's hits off the screen takes
  // the debounce window into `isSearching` as well — see below.
  const debouncedQuery = useDebouncedValue(
    searchQuery.trim(),
    DOCS_SEARCH_DEBOUNCE_MS
  );
  const searchResult = useDocsHelpSearch(debouncedQuery);

  const selectPage = useCallback((path: string, headingSlug?: string) => {
    setSelectedPath(path);
    setPendingHeadingSlug(headingSlug ?? null);
  }, []);

  const onHeadingHandled = useCallback(() => setPendingHeadingSlug(null), []);

  // Open on the first navigable page, the way desktop's host does: the surface
  // renders NOTHING for `idle`, and a blank reader pane beside a full nav tree
  // is the one no-content state that makes no claim at all — a reader cannot
  // tell it from a pane that failed. Read through the shared guard, so a
  // malformed first group does not take the route down and discard the groups
  // that arrived intact.
  const navGroups = nav.data;
  useEffect(() => {
    if (navGroups === undefined || selectedPath !== null) {
      return;
    }
    const firstPath = firstNavigablePath(navGroups);
    if (firstPath !== null) {
      setSelectedPath(firstPath);
    }
  }, [navGroups, selectedPath]);

  const page: DocsHelpPageState = useMemo(() => {
    if (selectedPath === null) {
      return { kind: "idle" };
    }
    if (pageQuery.data !== undefined) {
      return { kind: "found", page: pageQuery.data };
    }
    if (pageQuery.error instanceof DocsHelpPageMissingError) {
      return { kind: "missing" };
    }
    return pageQuery.error === null ? { kind: "loading" } : { kind: "error" };
  }, [pageQuery.data, pageQuery.error, selectedPath]);

  // Through the SAME guard desktop runs its hits through. It is the one payload
  // the surface does not check itself, and an unreadable reply that skipped it
  // renders as `No results for "…"` — or throws on `hits.length` and unwinds the
  // route, which is the failure the guard's own docstring names.
  const rawHits = searchResult.data;
  const searchHits = useMemo(() => readSearchHits(rawHits ?? []), [rawHits]);
  const searchFailed =
    searchResult.isError ||
    (rawHits !== undefined && isSearchHitsUnreadable(rawHits));

  const source: DocsHelpSource = {
    bundleStatus: bundleStatusOf(nav.isError, navGroups !== undefined),
    docsSiteUrl,
    // `isFetching` alone is FALSE for the whole debounce window — the old key
    // has settled and the new one does not exist yet — so the pane would render
    // the previous query's hits, or `No results for "<the new query>"`, under
    // text nothing has searched for (tamsinb review). That is the claim about
    // an unsearched corpus `searchFailed` exists to stop, one state over.
    // Desktop has no such window: `use-docs-help.ts` sets its searching flag
    // before the timeout, not after it.
    isSearching:
      searchResult.isFetching || debouncedQuery !== searchQuery.trim(),
    // `[]` is the LOADING and FAILED shape only, and neither is read as a tree:
    // a failed nav read is `Unavailable` above, and a loading one is `Loading`.
    // A SETTLED value is passed through untouched — `?? []` would swallow the
    // `null` the nav read returns for a reply that carried no `navGroups`, and
    // the surface's guard needs that non-array to report `treeUnreadable`
    // rather than an empty tree (whitlockk review).
    navGroups: navGroups === undefined ? [] : navGroups,
    onHeadingHandled,
    onSearchQueryChange: setSearchQuery,
    page,
    pendingHeadingSlug,
    searchFailed,
    searchHits,
    searchQuery,
    selectPage,
    selectedPath,
  };

  return (
    <HelpSurfaceV2
      corpusCopy={corpusCopyFor(nav.error)}
      slugifyHeading={slugifyHeading}
      source={source}
    />
  );
}

/**
 * The sentence that names WHY there are no docs. A corpus this deployment never
 * shipped is permanent, so the generic "just now" wording would tell the reader
 * to wait for something that cannot change (marisolashgrove review); every other
 * failure keeps it, because re-reading really may work.
 */
function corpusCopyFor(error: unknown) {
  if (
    error instanceof DocsCorpusUnavailableError &&
    error.reason === DocsCorpusFailureReason.NotDeployed
  ) {
    return WEB_DOCS_CORPUS_COPY_NOT_DEPLOYED;
  }
  return WEB_DOCS_CORPUS_COPY;
}

function bundleStatusOf(
  failed: boolean,
  settled: boolean
): DocsHelpBundleStatus {
  if (failed) {
    return DocsHelpBundleStatus.Unavailable;
  }
  return settled ? DocsHelpBundleStatus.Ready : DocsHelpBundleStatus.Loading;
}
