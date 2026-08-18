/**
 * Debounced docs search for the command-palette Docs group (FEA-3845 / PRD-555
 * M3).
 *
 * Owns the read-only conversation with the M1 `docs-help` search IPC
 * (`window.desktopApi.docsHelp.search`): a trimmed, debounced query in → ranked
 * hits out. Mirrors the debounce/cancel discipline of the M2 Help view's
 * `useDocsHelp` search effect, scoped down to just the palette's needs (no page
 * fetch, no nav tree). An empty query clears results without hitting IPC.
 */
import { useEffect, useState } from "react";
import type { DocsHelpSearchHit } from "../../../shared/docs-help-contract";

const SEARCH_DEBOUNCE_MS = 150;

/** Ranked hits the palette shows, capped so the group stays scannable. */
const MAX_DOCS_COMMAND_HITS = 8;

type DocsHelpApi = NonNullable<Window["desktopApi"]>["docsHelp"];

export type UseDocsCommandSearch = {
  hits: readonly DocsHelpSearchHit[];
  isSearching: boolean;
};

function getDocsHelpApi(): DocsHelpApi | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.desktopApi?.docsHelp ?? null;
}

export function useDocsCommandSearch(query: string): UseDocsCommandSearch {
  const [hits, setHits] = useState<readonly DocsHelpSearchHit[]>([]);
  // The trimmed query the current `hits` were resolved for (empty until a
  // search settles). Comparing it to the live query tells us when results are
  // stale/in-flight — including the very first render after a keystroke, before
  // the debounce effect runs — so the group never flashes "no results" for a
  // query it hasn't actually searched yet.
  const [resolvedQuery, setResolvedQuery] = useState("");

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setHits([]);
      setResolvedQuery("");
      return;
    }
    const api = getDocsHelpApi();
    if (!api) {
      setHits([]);
      // No IPC available: this query is "settled" (empty) so the group shows the
      // no-results state rather than a permanent spinner.
      setResolvedQuery(trimmed);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .search(trimmed, MAX_DOCS_COMMAND_HITS)
        .then((result) => {
          if (!cancelled) {
            setHits(result.hits);
            setResolvedQuery(trimmed);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setHits([]);
            setResolvedQuery(trimmed);
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const trimmedQuery = query.trim();
  // Searching while a non-empty query has not yet resolved to its own results.
  const isSearching = trimmedQuery.length > 0 && trimmedQuery !== resolvedQuery;
  // Only surface hits once they belong to the live query (avoids showing the
  // previous query's hits during the debounce window).
  return {
    hits: isSearching ? [] : hits,
    isSearching,
  };
}
