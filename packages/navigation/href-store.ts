import type {
  NavigateOptions,
  NavigationActions,
  ReadonlySearchParams,
} from "./navigation-adapter";

/**
 * Framework-free href history store backing routerless navigation adapters
 * (the in-memory test/story adapter and the desktop renderer adapter).
 * Maintains a navigate/replace/back/forward stack over full hrefs (path + query) and
 * exposes snapshot getters compatible with `useSyncExternalStore`.
 */
export type HrefStoreOptions = {
  /** First stack entry. Defaults to "/". */
  initialHref?: string;
  /**
   * Called after navigate/replace/back/forward changes the current href — the
   * persistence seam (the desktop adapter writes the hash here). NOT called
   * for `syncExternalHref`, which adopts a change the host already made.
   */
  onHrefChange?: (href: string) => void;
  /**
   * Behavior for `NavigationActions.refresh`. Surfaces decide what
   * re-synchronizing with source data means (memory adapter: count calls;
   * desktop: no-op until a query-invalidation hook exists).
   */
  onRefresh?: () => void;
};

export type HrefStore = {
  /** Stable action object satisfying the port's referential-stability contract. */
  actions: NavigationActions;
  subscribe: (listener: () => void) => () => void;
  /** Current full href (path + query). */
  getHref: () => string;
  /** Current path without query. */
  getPath: () => string;
  /**
   * Current search params. Cached per change so `useSyncExternalStore`
   * getSnapshot returns a referentially stable value between emits.
   */
  getSearchSnapshot: () => ReadonlySearchParams;
  /**
   * Counts every location change the store has emitted. One value per router
   * state, so every hook that reads it in the same render sees the same number.
   */
  getEpoch: () => number;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  /**
   * Adopt an href changed outside the store (e.g. a hashchange the store did
   * not write). Pushes a new entry when it differs from the current href;
   * does NOT invoke `onHrefChange` (the host already has this value).
   */
  syncExternalHref: (href: string) => void;
  /** Hrefs visited in order, including the initial one and replace targets. */
  getHistory: () => readonly string[];
};

export function createHrefStore(options: HrefStoreOptions = {}): HrefStore {
  const { initialHref = "/", onHrefChange, onRefresh } = options;

  let stack: string[] = [initialHref];
  let index = 0;
  const visited: string[] = [initialHref];
  let searchSnapshot = parseSearch(initialHref);
  const listeners = new Set<() => void>();

  // searchSnapshot is a cache recomputed in emit() AFTER every stack/index
  // mutation (navigate/replace/back/syncExternalHref all mutate first, then
  // emit). It must stay cached — useSyncExternalStore's getSnapshot has to
  // return a referentially stable value between emits; computing
  // parseSearch(...) inline would return a fresh URLSearchParams each call
  // and loop renders.
  let epoch = 0;
  const emit = () => {
    epoch += 1;
    searchSnapshot = parseSearch(stack[index]);
    for (const listener of listeners) {
      listener();
    }
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const navigate = (href: string, _options?: NavigateOptions) => {
    stack = [...stack.slice(0, index + 1), href];
    index += 1;
    visited.push(href);
    emit();
    onHrefChange?.(href);
  };

  const replace = (href: string, _options?: NavigateOptions) => {
    // Replacement preserves the forward branch, just like browser history;
    // only a new navigation after Back discards it (ISS-10795).
    stack[index] = href;
    visited.push(href);
    emit();
    onHrefChange?.(href);
  };

  const back = () => {
    if (index === 0) {
      return;
    }
    index -= 1;
    emit();
    onHrefChange?.(stack[index]);
  };

  const forward = () => {
    if (index >= stack.length - 1) {
      return;
    }
    index += 1;
    emit();
    onHrefChange?.(stack[index]);
  };

  const refresh = () => {
    onRefresh?.();
  };

  const actions: NavigationActions = {
    navigate,
    replace,
    back,
    forward,
    refresh,
  };

  const syncExternalHref = (href: string) => {
    if (href === stack[index]) {
      return;
    }
    stack = [...stack.slice(0, index + 1), href];
    index += 1;
    visited.push(href);
    emit();
  };

  return {
    actions,
    subscribe,
    getHref: () => stack[index],
    getPath: () => parsePath(stack[index]),
    getSearchSnapshot: () => searchSnapshot,
    getEpoch: () => epoch,
    canGoBack: () => index > 0,
    canGoForward: () => index < stack.length - 1,
    syncExternalHref,
    getHistory: () => [...visited],
  };
}

/** Path portion of an href (query stripped). Shared with href-based adapters. */
export function parsePath(href: string): string {
  const queryStart = href.indexOf("?");
  if (queryStart === -1) {
    return href;
  }
  return href.slice(0, queryStart);
}

function parseSearch(href: string): ReadonlySearchParams {
  const queryStart = href.indexOf("?");
  if (queryStart === -1) {
    return new URLSearchParams();
  }
  return new URLSearchParams(href.slice(queryStart + 1));
}
