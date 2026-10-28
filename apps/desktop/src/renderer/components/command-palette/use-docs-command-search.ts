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
import { useCallback, useEffect, useState } from "react";
import type { DocsHelpSearchHit } from "../../../shared/docs-help-contract";
import { getDocsHelpApi } from "../help/docs-help-api";

const SEARCH_DEBOUNCE_MS = 150;

/** Ranked hits the palette shows, capped so the group stays scannable. */
const MAX_DOCS_COMMAND_HITS = 8;

export type UseDocsCommandSearch = {
  hits: readonly DocsHelpSearchHit[];
  isSearching: boolean;
  /**
   * The docs index could not answer — the search IPC rejected, or the preload
   * bridge is absent in this renderer. ISS-9414: without this, a failed search
   * and an empty corpus were the same `hits: []`, so the palette told the user
   * "no documentation matches" for a query it never managed to run.
   */
  hasFailed: boolean;
  /** Re-issues the current query. Wired to the surface's unavailable retry. */
  retry: () => void;
};

export function useDocsCommandSearch(query: string): UseDocsCommandSearch {
  const [hits, setHits] = useState<readonly DocsHelpSearchHit[]>([]);
  const [hasFailed, setHasFailed] = useState(false);
  // Bumped by `retry`, and read by the search effect, so a retry re-runs the
  // IPC call for an unchanged query — which re-running off `query` alone
  // cannot do, because the dependency has not changed.
  const [retryNonce, setRetryNonce] = useState(0);
  // The trimmed query the current `hits` were resolved for (empty until a
  // search settles). Comparing it to the live query tells us when results are
  // stale/in-flight — including the very first render after a keystroke, before
  // the debounce effect runs — so the group never flashes "no results" for a
  // query it hasn't actually searched yet.
  const [resolvedQuery, setResolvedQuery] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryNonce is an intentional restart trigger (the surface's Retry bumps it), not a value read inside the effect — a retry for an UNCHANGED query has no other dependency that could change.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setHits([]);
      setHasFailed(false);
      setResolvedQuery("");
      return;
    }
    const api = getDocsHelpApi();
    if (!api) {
      setHits([]);
      // No IPC bridge in this renderer: the query is settled, and settled as
      // UNANSWERABLE. It is not an empty corpus — nothing was searched.
      setHasFailed(true);
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
            setHasFailed(false);
            setResolvedQuery(trimmed);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setHits([]);
            setHasFailed(true);
            setResolvedQuery(trimmed);
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, retryNonce]);

  const retry = useCallback(() => {
    // Clearing the resolved query is what makes the retry VISIBLE. `isSearching`
    // is "the live query differs from the one the current results belong to",
    // and a failure sets them equal — so bumping the nonce alone re-issued the
    // IPC while the surface kept rendering the settled failure for the whole
    // debounce and round trip. A second failure then changed nothing on screen.
    setResolvedQuery("");
    setRetryNonce((nonce) => nonce + 1);
  }, []);

  const trimmedQuery = query.trim();
  // Searching while a non-empty query has not yet resolved to its own results.
  const isSearching = trimmedQuery.length > 0 && trimmedQuery !== resolvedQuery;
  // Only surface hits once they belong to the live query (avoids showing the
  // previous query's hits during the debounce window).
  return {
    hits: isSearching ? [] : hits,
    isSearching,
    hasFailed: !isSearching && hasFailed,
    retry,
  };
}
