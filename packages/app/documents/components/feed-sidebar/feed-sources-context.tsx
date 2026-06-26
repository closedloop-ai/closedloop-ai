"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { AnyFeedSource } from "./feed-source";

const EMPTY_SOURCES: readonly AnyFeedSource[] = [];

const FeedSourcesContext =
  createContext<readonly AnyFeedSource[]>(EMPTY_SOURCES);

export type FeedSourcesProviderProps = {
  sources: readonly AnyFeedSource[];
  children: ReactNode;
};

/**
 * Exposes the active sources array to descendant components (filter bar,
 * filter context, composer slot). Callers MUST memoize the array — the
 * filter-state provider initializes per-source defaults from this array
 * on mount and re-mounts when its identity changes.
 */
export function FeedSourcesProvider({
  sources,
  children,
}: Readonly<FeedSourcesProviderProps>) {
  return (
    <FeedSourcesContext.Provider value={sources}>
      {children}
    </FeedSourcesContext.Provider>
  );
}

export function useFeedSources(): readonly AnyFeedSource[] {
  return useContext(FeedSourcesContext);
}
