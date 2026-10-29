"use client";

import {
  SearchSurfaceState,
  searchSurfaceState,
} from "../lib/search-surface-model";
import type { SearchSurfaceV2Props } from "./search-surface-v2-props";
import { SearchSurfaceRows } from "./search-surface-v2-rows";
import { SearchSurfaceStates } from "./search-surface-v2-states";

/**
 * Search results and command entry, complete (ISS-9414, PRD-730
 * `wave-fs-4-contextual`).
 *
 * Owns the result model, the ordering, the row body, the semantic destination
 * of every row, and which of the five {@link SearchSurfaceState}s renders. A
 * shell supplies only host-boundary seams.
 *
 * Web has a `/search` route; Desktop has a ⌘K palette and no Search route
 * identity at all, so the mode is explicit rather than one layout forced on
 * both. It changes the container, never the behavior model: the ladder, the
 * ranking, the labels and the destinations are identical and checked to be by
 * `search-surface-both-host-contract`. The query input, the ⌘K chord and
 * Escape stay with the shell.
 *
 * Closed by default on both shells behind ONE PostHog key, read once per shell
 * at the mount site. This surface does not know that gate exists.
 */
export function SearchSurfaceV2({
  mode,
  onActivateResult,
  onRetry,
  query,
  read,
  results,
}: SearchSurfaceV2Props) {
  const state = searchSurfaceState(read);
  return (
    <div
      className="flex flex-col gap-4"
      data-testid={SEARCH_SURFACE_V2_TEST_ID}
    >
      {state === SearchSurfaceState.Ready ? (
        <SearchSurfaceRows
          mode={mode}
          onActivateResult={onActivateResult}
          results={results}
        />
      ) : (
        <SearchSurfaceStates
          mode={mode}
          onRetry={onRetry}
          query={query}
          state={state}
          unavailableReason={read.unavailableReason}
        />
      )}
    </div>
  );
}

/**
 * Marks the surface's root so each shell's E2E can prove WHICH branch of the
 * flag rendered — the two branches share copy, so an absence written against
 * copy would pass either way.
 */
export const SEARCH_SURFACE_V2_TEST_ID = "search-surface-v2";
