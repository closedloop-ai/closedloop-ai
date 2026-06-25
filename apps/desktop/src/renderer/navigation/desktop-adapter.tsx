import { createHrefLink } from "@repo/navigation/href-link";
import { createHrefStore, parsePath } from "@repo/navigation/href-store";
import type {
  NavigationActions,
  NavigationAdapter,
  OrgPathBuilder,
  RouteParams,
} from "@repo/navigation/navigation-adapter";
import { useSyncExternalStore } from "react";
import {
  DEFAULT_NAV_ID,
  hashToHrefEntries,
  hrefForNavId,
  matchRoute,
} from "./route-table";

/**
 * Desktop implementation of the navigation port (FEA-1518). Shared
 * @repo/app components keep navigating with URL-shaped org-relative hrefs;
 * this adapter resolves them through the route table and drives the
 * renderer's view state — no router (FEA-1497: nav-stack over react-router).
 *
 * The current href persists to `location.hash` ("#/sessions/123?tab=events")
 * so reload/window-restore keeps the view; external hash changes (including
 * the legacy "#tab=…&sessionId=…" scheme) sync back into the store.
 */
export type DesktopHashHost = {
  /** Raw hash including the leading "#" (or ""). */
  getHash: () => string;
  /** Persist an href as the hash; implementations skip no-op writes. */
  setHash: (href: string) => void;
  /** Subscribe to external hash changes; returns the detach function. */
  onHashChange: (listener: () => void) => () => void;
};

export type DesktopNavigation = {
  adapter: NavigationAdapter;
  /** Current full href (path + query) — App-level back-fallback + tests. */
  getHref: () => string;
  canGoBack: () => boolean;
  /** Hrefs visited in order — App seeds the originating tab from this. */
  getHistory: () => readonly string[];
  /** Detaches the hashchange listener (tests). */
  dispose: () => void;
};

export function createDesktopNavigation(
  host: DesktopHashHost = createWindowHashHost()
): DesktopNavigation {
  // A persisted hash can carry a path the table no longer (or never) mapped;
  // unmapped entries are dropped so the store only ever holds renderable
  // locations, falling back to the default view.
  const entries = hashToHrefEntries(host.getHash()).filter((href) =>
    matchRoute(parsePath(href))
  );
  const store = createHrefStore({
    initialHref: entries[0] ?? hrefForNavId(DEFAULT_NAV_ID),
    onHrefChange: (href) => host.setHash(href),
  });
  // A legacy tab+sessionId hash migrates to a two-entry stack (tab, then
  // detail) so back() from the detail returns to the originating tab. The
  // extra navigate also rewrites the hash into the canonical path scheme.
  for (const href of entries.slice(1)) {
    store.actions.navigate(href);
  }
  host.setHash(store.getHref());

  const dispose = host.onHashChange(() => {
    const href = hashToHrefEntries(host.getHash()).at(-1);
    // Same unmapped policy as the actions guard: an external hash pointing
    // nowhere renderable is ignored rather than stranding the view.
    if (href !== undefined && matchRoute(parsePath(href))) {
      store.syncExternalHref(href);
      // An adopted legacy-scheme hash is rewritten in place so the persisted
      // hash always carries the canonical path form.
      host.setHash(href);
    }
  });

  // Unmapped-href guard (AC-021.6): an href with no route-table entry would
  // strand the renderer on an unrenderable location, so navigation to it is
  // dropped. Centralized here so port Links and programmatic navigate() get
  // the same policy.
  const guardedActions: NavigationActions = {
    navigate: (href, options) => {
      if (matchRoute(parsePath(href))) {
        store.actions.navigate(href, options);
      } else {
        handleUnmappedHref(href);
      }
    },
    replace: (href, options) => {
      if (matchRoute(parsePath(href))) {
        store.actions.replace(href, options);
      } else {
        handleUnmappedHref(href);
      }
    },
    back: store.actions.back,
    refresh: store.actions.refresh,
  };

  // Cache keyed by href so useSyncExternalStore's getSnapshot returns a
  // referentially stable params object between location changes.
  let paramsCache: { href: string; params: RouteParams } = {
    href: store.getHref(),
    params: matchRoute(store.getPath())?.params ?? {},
  };
  const getRouteParamsSnapshot = (): RouteParams => {
    const href = store.getHref();
    if (paramsCache.href !== href) {
      paramsCache = { href, params: matchRoute(parsePath(href))?.params ?? {} };
    }
    return paramsCache.params;
  };

  const adapter: NavigationAdapter = {
    // Stable closures over the store — no hook call needed to satisfy the
    // port's referential-stability contract (same rationale as the memory
    // adapter; trivially rules-of-hooks safe).
    useNavigationActions: () => guardedActions,
    usePathValue: () =>
      useSyncExternalStore(store.subscribe, store.getPath, store.getPath),
    useRouteParamsValue: () =>
      useSyncExternalStore(
        store.subscribe,
        getRouteParamsSnapshot,
        getRouteParamsSnapshot
      ),
    useSearchParamsSnapshot: () =>
      useSyncExternalStore(
        store.subscribe,
        store.getSearchSnapshot,
        store.getSearchSnapshot
      ),
    useOrgPathBuilder: () => identityOrgPath,
    Link: createHrefLink(guardedActions),
  };

  return {
    adapter,
    getHref: store.getHref,
    canGoBack: store.canGoBack,
    getHistory: store.getHistory,
    dispose,
  };
}

/**
 * Single-player desktop has no URL-visible org, so org-relative paths pass
 * through unchanged (the OrgPathBuilder contract's no-slug case).
 */
const identityOrgPath: OrgPathBuilder = (orgRelativePath) => orgRelativePath;

/**
 * Extension point for hrefs the route table does not map (e.g. /users/:id —
 * web-only until the sync phase brings cloud identity). MLP policy is
 * drop-the-navigation; a later phase can hand off to the external browser
 * here once an org-scoped cloud URL can be built.
 */
function handleUnmappedHref(_href: string): void {
  // Intentionally empty (AC-021.6). No client-side logging per repo policy.
}

function createWindowHashHost(): DesktopHashHost {
  return {
    getHash: () => globalThis.location.hash,
    setHash: (href) => {
      if (globalThis.location.hash.slice(1) !== href) {
        globalThis.location.hash = href;
      }
    },
    onHashChange: (listener) => {
      globalThis.addEventListener("hashchange", listener);
      return () => globalThis.removeEventListener("hashchange", listener);
    },
  };
}
