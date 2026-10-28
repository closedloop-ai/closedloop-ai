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
  normalizeRouteHref,
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
  /** Subscribe to hash changes; returns the detach function. */
  onHashChange: (listener: (rawHash?: string) => void) => () => void;
};

export type DesktopNavigation = {
  adapter: NavigationAdapter;
  /** Whether startup came from shell entry instead of an explicit hash route. */
  initialHashWasEmpty: boolean;
  /** Whether any post-start navigation/hash intent has claimed the shell entry. */
  hasPostStartupNavigationIntent: () => boolean;
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
  const initialHash = host.getHash();
  const initialHashWasEmpty = isEmptyHash(initialHash);
  const expectedInternalHashes: string[] = [];
  let postStartupNavigationIntent = false;
  const persistHref = (href: string) => {
    const rawHash = normalizeDesktopHash(toDesktopHashHref(href));
    if (normalizeDesktopHash(host.getHash()) !== rawHash) {
      expectedInternalHashes.push(rawHash);
    }
    host.setHash(href);
  };
  // A persisted hash can carry a path the table no longer (or never) mapped;
  // unmapped entries are dropped so the store only ever holds renderable
  // locations, falling back to the default view.
  const entries = hashToHrefEntries(initialHash).filter((href) =>
    matchRoute(parsePath(href))
  );
  const store = createHrefStore({
    initialHref: entries[0] ?? hrefForNavId(DEFAULT_NAV_ID),
    onHrefChange: persistHref,
  });
  const dispose = host.onHashChange((changedRawHash = host.getHash()) => {
    const rawHash = normalizeDesktopHash(changedRawHash);
    const currentRawHash = normalizeDesktopHash(host.getHash());
    if (consumeExpectedInternalHash(expectedInternalHashes, rawHash)) {
      return;
    }
    if (rawHash !== currentRawHash) {
      return;
    }
    postStartupNavigationIntent = true;
    const href = hashToHrefEntries(rawHash).at(-1);
    // Same unmapped policy as the actions guard: an external hash pointing
    // nowhere renderable is ignored rather than stranding the view.
    if (href !== undefined && matchRoute(parsePath(href))) {
      store.syncExternalHref(href);
      // An adopted legacy-scheme hash is rewritten in place so the persisted
      // hash always carries the canonical path form.
      persistHref(href);
    }
  });
  // A legacy tab+sessionId hash migrates to a two-entry stack (tab, then
  // detail) so back() from the detail returns to the originating tab. The
  // extra navigate also rewrites the hash into the canonical path scheme.
  for (const href of entries.slice(1)) {
    store.actions.navigate(href);
  }
  persistHref(store.getHref());

  // Unmapped-href guard (AC-021.6): an href with no route-table entry would
  // strand the renderer on an unrenderable location, so navigation to it is
  // dropped. Centralized here so port Links and programmatic navigate() get
  // the same policy.
  const guardedActions: NavigationActions = {
    navigate: (href, options) => {
      postStartupNavigationIntent = true;
      const normalizedHref = normalizeRouteHref(href);
      if (matchRoute(parsePath(normalizedHref))) {
        store.actions.navigate(normalizedHref, options);
      } else {
        handleUnmappedHref(href);
      }
    },
    replace: (href, options) => {
      postStartupNavigationIntent = true;
      const normalizedHref = normalizeRouteHref(href);
      if (matchRoute(parsePath(normalizedHref))) {
        store.actions.replace(normalizedHref, options);
      } else {
        handleUnmappedHref(href);
      }
    },
    back: () => {
      if (store.canGoBack()) {
        postStartupNavigationIntent = true;
      }
      store.actions.back();
    },
    forward: () => {
      if (store.canGoForward()) {
        postStartupNavigationIntent = true;
      }
      store.actions.forward();
    },
    refresh: () => {
      store.actions.refresh();
    },
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
    useNavigationEpoch: () =>
      useSyncExternalStore(store.subscribe, store.getEpoch, store.getEpoch),
    useOrgPathBuilder: () => identityOrgPath,
    // Render the anchor's href hash-prefixed so modifier/middle/right-click —
    // which bypass the click handler and defer to the browser — resolve as a
    // same-document hash the hash-store adapter adopts, instead of a bare
    // `file:///agents/…` document nav the Electron guard blocks (FEA-4018).
    // The click handler still navigates the internal path (guardedActions).
    Link: createHrefLink(guardedActions, toDesktopHashHref),
  };

  return {
    adapter,
    initialHashWasEmpty,
    hasPostStartupNavigationIntent: () => postStartupNavigationIntent,
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

/**
 * Maps an internal org-relative navigation path to the browser-safe href the
 * anchor renders. The desktop renderer persists its location as `location.hash`
 * ("#/agents/foo"), so a modifier/middle/right-click that defers to the browser
 * must target that hash form — a bare "/agents/foo" would be a `file://`
 * document nav the Electron guard blocks (FEA-4018). Already-hash hrefs pass
 * through unchanged.
 */
function toDesktopHashHref(href: string): string {
  return href.startsWith("#") ? href : `#${href}`;
}

function isEmptyHash(rawHash: string): boolean {
  return rawHash === "" || rawHash === "#";
}

function consumeExpectedInternalHash(
  expectedHashes: string[],
  rawHash: string
): boolean {
  const matchIndex = expectedHashes.indexOf(rawHash);
  if (matchIndex === -1) {
    return false;
  }
  expectedHashes.splice(0, matchIndex + 1);
  return true;
}

function normalizeDesktopHash(rawHash: string): string {
  try {
    return new URL(rawHash, "https://desktop.local").hash;
  } catch {
    return rawHash;
  }
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
      const handleHashChange = (event: HashChangeEvent) => {
        const rawHash =
          typeof event.newURL === "string" && event.newURL !== ""
            ? event.newURL
            : globalThis.location.hash;
        listener(normalizeDesktopHash(rawHash));
      };
      globalThis.addEventListener("hashchange", handleHashChange);
      return () =>
        globalThis.removeEventListener("hashchange", handleHashChange);
    },
  };
}
