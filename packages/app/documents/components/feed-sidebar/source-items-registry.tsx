"use client";

import {
  createContext,
  type ReactNode,
  Suspense,
  useContext,
  useMemo,
} from "react";
import type { FeedItem } from "./feed-item";
import type { AnyFeedSource, FeedSourceUseItemsResult } from "./feed-source";

export type RegisteredSource = {
  source: AnyFeedSource;
  result: FeedSourceUseItemsResult<FeedItem>;
};

export type SourceItemsRegistry = ReadonlyMap<string, RegisteredSource>;

const EMPTY_REGISTRY: SourceItemsRegistry = new Map();

const SourceItemsContext = createContext<SourceItemsRegistry>(EMPTY_REGISTRY);

/**
 * Consumer hook. Returns the entire registry as a Map keyed by
 * `source.id`. Both the merged stream and the filter bar read from this
 * to avoid calling any source's `useItems()` directly — that would
 * violate rules-of-hooks (see `FeedSource.useItems` doc).
 */
export function useAllSourceItems(): SourceItemsRegistry {
  return useContext(SourceItemsContext);
}

/**
 * Returns the registered result for a single source, or `undefined`
 * when the source is not mounted in the current runtime (e.g. during
 * the Suspense fallback).
 */
export function useSourceItems(sourceId: string): RegisteredSource | undefined {
  return useAllSourceItems().get(sourceId);
}

type SourceItemsProviderProps = {
  source: AnyFeedSource;
  children: ReactNode;
};

/**
 * Stable child component, one per `source.id`. Calls `source.useItems()`
 * exactly once and contributes its row into the surrounding registry.
 * Liveblocks-style suspending sources are caught by the enclosing
 * `<Suspense>` boundary mounted by `FeedRuntime`.
 */
function SourceItemsProvider({
  source,
  children,
}: Readonly<SourceItemsProviderProps>) {
  const result = source.useItems() as FeedSourceUseItemsResult<FeedItem>;
  const parent = useContext(SourceItemsContext);
  const next = useMemo<SourceItemsRegistry>(() => {
    const merged = new Map(parent);
    merged.set(source.id, { source, result });
    return merged;
  }, [parent, source, result]);
  return (
    <SourceItemsContext.Provider value={next}>
      {children}
    </SourceItemsContext.Provider>
  );
}

export type FeedRuntimeProps = {
  sources: readonly AnyFeedSource[];
  fallback: ReactNode;
  children: ReactNode;
};

/**
 * Mounts one `<SourceItemsProvider>` per source unconditionally,
 * keyed by `source.id`. `reduceRight` nests providers so the registry
 * accumulates from the deepest source outward; child order is stable
 * across renders for any given memoized `sources` array.
 *
 * A single `<Suspense>` boundary wraps the entire registry stack: when
 * any source's `useItems()` suspends, the fallback replaces the whole
 * inner tree (including the filter bar + stream) until it resolves.
 *
 * **Caller MUST memoize `sources`** — the registry providers re-mount
 * when the array identity changes, which would lose any in-flight
 * resolution.
 */
export function FeedRuntime({
  sources,
  fallback,
  children,
}: Readonly<FeedRuntimeProps>) {
  const tree = sources.reduceRight<ReactNode>(
    (inner, source) => (
      <SourceItemsProvider key={source.id} source={source}>
        {inner}
      </SourceItemsProvider>
    ),
    children
  );
  return <Suspense fallback={fallback}>{tree}</Suspense>;
}
