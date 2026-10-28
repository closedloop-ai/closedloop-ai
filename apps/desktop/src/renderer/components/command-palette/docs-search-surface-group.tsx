/**
 * The DESKTOP host of `SearchSurfaceV2` (ISS-9414, PRD-730
 * `wave-fs-4-contextual`).
 *
 * WHAT THIS FILE IS ALLOWED TO DECIDE, and it is only two things: the transport
 * (`docsHelp.search` over IPC, through `useDocsCommandSearch`) and the ROUTE a
 * hit resolves to (`helpPageHref`, the hash route table's Help entry). Both are
 * host-boundary seams. Ordering, labels, the row body, the state ladder and the
 * destinations a reader lands on all belong to the surface, so the palette can
 * no longer render search differently from `/search` by composing beside it.
 *
 * The local docs index has no updated-at per page, so a row carries no `meta`.
 * Inventing one would be exactly the plausible-but-wrong value the package
 * guidelines bar.
 */
import { SearchSurfaceV2 } from "@repo/app/search/components/search-surface-v2";
import { SearchSurfaceModeKind } from "@repo/app/search/components/search-surface-v2-props";
import { docsHitsToSurfaceResults } from "./docs-search-surface-results";
import { useDocsCommandSearch } from "./use-docs-command-search";

type DocsSearchSurfaceGroupProps = {
  query: string;
  /** Dismiss the palette; the row's own href performs the navigation. */
  onDismiss: () => void;
};

export function DocsSearchSurfaceGroup({
  onDismiss,
  query,
}: Readonly<DocsSearchSurfaceGroupProps>) {
  const { hasFailed, hits, isSearching, retry } = useDocsCommandSearch(query);
  return (
    <SearchSurfaceV2
      mode={{
        kind: SearchSurfaceModeKind.Overlay,
        groupHeading: DOCS_RESULT_GROUP_HEADING,
        notRunPrompt: DOCS_NOT_RUN_PROMPT,
      }}
      onActivateResult={onDismiss}
      onRetry={retry}
      query={query}
      read={{
        // The palette issues a search for any non-empty trimmed query — the
        // same floor `useDocsCommandSearch` clears results at, so the surface
        // never claims an empty corpus for a query the hook never sent.
        hasRun: query.trim().length > 0,
        isLoading: isSearching,
        isUnavailable: hasFailed,
        // The docs IPC reports a rejection, never a safe-to-show sentence about
        // the query itself, so this host has no reason to pass on. Null keeps
        // the retry affordance the failure actually warrants.
        unavailableReason: null,
        resultCount: hits.length,
      }}
      results={docsHitsToSurfaceResults(hits)}
    />
  );
}

/** Names the palette's result group. Desktop's corpus is the docs index. */
const DOCS_RESULT_GROUP_HEADING = "Docs";

/**
 * The palette's empty-query line. Exported because BOTH flag branches render
 * it, and the desktop E2E treats the two branches saying the same sentence as
 * an invariant — one that eight separate string literals cannot hold.
 */
export const DOCS_NOT_RUN_PROMPT = "Type to search the documentation.";
