"use client";

import { useSyncExternalStore } from "react";
import { createHrefLink } from "./href-link";
import { createHrefStore } from "./href-store";
import type { NavigationAdapter, RouteParams } from "./navigation-adapter";

/**
 * In-memory navigation adapter. Proves shared components navigate without
 * any web routing (FEA-1509 AC-020.3) and backs unit tests for code that
 * consumes the port. Not used in production surfaces — the desktop renderer
 * builds its production adapter on the same href store
 * (apps/desktop/src/renderer/navigation/desktop-adapter.tsx).
 */
export type MemoryNavigationOptions = {
  initialPath?: string;
  routeParams?: RouteParams;
  /**
   * Active org slug used by the `useOrgPath` builder. When omitted the builder
   * returns org-relative paths unchanged (a shell with no URL-visible org).
   */
  orgSlug?: string;
};

export type MemoryNavigation = {
  adapter: NavigationAdapter;
  /** Current full href (path + query). */
  getCurrentHref: () => string;
  /** Hrefs visited in order, including the initial one. */
  getHistory: () => readonly string[];
  /** Number of refresh() calls observed. */
  getRefreshCount: () => number;
};

export function createMemoryNavigation(
  options: MemoryNavigationOptions = {}
): MemoryNavigation {
  const { initialPath = "/", routeParams = {}, orgSlug } = options;
  const buildOrgPath = (path: string) =>
    orgSlug ? `/${orgSlug}${path}` : path;

  let refreshCount = 0;
  const store = createHrefStore({
    initialHref: initialPath,
    onRefresh: () => {
      refreshCount += 1;
    },
  });

  const adapter: NavigationAdapter = {
    // Intentional deviation from the "use* members are hooks" guidance in
    // navigation-adapter.ts: the store's actions are a single stable closure
    // over mutable stack/index, so no hook call is needed to satisfy the
    // referential-stability contract. Trivially rules-of-hooks safe (calls
    // zero hooks).
    useNavigationActions: () => store.actions,
    usePathValue: () =>
      useSyncExternalStore(store.subscribe, store.getPath, store.getPath),
    useRouteParamsValue: () => routeParams,
    useSearchParamsSnapshot: () =>
      useSyncExternalStore(
        store.subscribe,
        store.getSearchSnapshot,
        store.getSearchSnapshot
      ),
    // Stable closure over the fixed orgSlug option — no hook needed, same
    // rationale as useNavigationActions above.
    useOrgPathBuilder: () => buildOrgPath,
    Link: createHrefLink(store.actions),
  };

  return {
    adapter,
    getCurrentHref: store.getHref,
    getHistory: store.getHistory,
    getRefreshCount: () => refreshCount,
  };
}
