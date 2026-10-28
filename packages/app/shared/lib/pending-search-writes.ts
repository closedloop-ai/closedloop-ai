/**
 * Search strings this reader replaced into a route whose router snapshot has
 * not reflected them yet, keyed by path. Every writer of one route's query
 * builds from the newest of these, so two writers inside one render cycle
 * never start from the same stale snapshot and drop each other's params.
 *
 * Reads are pure; the queue changes only in `recordPendingSearch`,
 * `settlePendingSearch` and the writer-retention callbacks, which run from
 * effects and event handlers, never from render.
 */
type PendingSearch = {
  base: string;
  /** The host's navigation epoch when `base` was observed. */
  epoch: HostEpoch;
  queue: readonly string[];
};

/**
 * What identifies one router state for every hook that observes it: the
 * adapter's own navigation counter, which it bumps for every navigation that is
 * not a writer's own `replace`. An adapter with no counter (`null`) can only be
 * told about back and forward, through the browser's popstate. Never the
 * search-params object, which the web App Router hands each hook as its own
 * copy, and never `history.length`, which a same-URL push, a replaceState and
 * back or forward leave unchanged.
 */
type HostEpoch = {
  adapter: number | null;
  /** Only counted when the adapter has no epoch of its own. */
  popstates: number;
};

const pendingByPath = new Map<string, PendingSearch>();
const listenersByPath = new Map<string, Set<() => void>>();
const writersByPath = new Map<string, number>();

/**
 * Lets a React reader re-read `currentSearchForPath` through
 * `useSyncExternalStore` whenever this path's queue changes, so the queue is
 * an external store rather than module state read during render.
 */
export function subscribePendingSearch(
  path: string,
  listener: () => void
): () => void {
  const listeners = listenersByPath.get(path) ?? new Set<() => void>();
  listeners.add(listener);
  listenersByPath.set(path, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      listenersByPath.delete(path);
    }
  };
}

function notifyPendingSearch(path: string) {
  for (const listener of listenersByPath.get(path) ?? []) {
    listener();
  }
}

/**
 * The search string every writer should build from: the newest queued write
 * the router has not yet reported, otherwise the snapshot itself. A snapshot
 * that is neither the base nor a queued write, or a base snapshot under a
 * changed host navigation epoch, is a navigation the writers did not make, and
 * it wins over the queue.
 */
export function currentSearchForPath(
  path: string,
  snapshot: string,
  adapterEpoch: number | null
): string {
  const pending = pendingByPath.get(path);
  if (!pending) {
    return snapshot;
  }
  return (
    resolvePending(pending, snapshot, adapterEpoch).queue.at(-1) ?? snapshot
  );
}

/** Applies what `currentSearchForPath` read, dropping reflected or superseded writes. */
export function settlePendingSearch(
  path: string,
  snapshot: string,
  adapterEpoch: number | null
): void {
  const pending = pendingByPath.get(path);
  if (!pending) {
    return;
  }
  const settled = resolvePending(pending, snapshot, adapterEpoch);
  if (settled.queue.length === 0) {
    pendingByPath.delete(path);
  } else {
    pendingByPath.set(path, settled);
  }
  notifyPendingSearch(path);
}

/** Records a replace issued from `snapshot` so the next writer builds on it. */
export function recordPendingSearch(
  path: string,
  snapshot: string,
  adapterEpoch: number | null,
  search: string
): void {
  const current = currentSearchForPath(path, snapshot, adapterEpoch);
  if (search === current) {
    return;
  }
  settlePendingSearch(path, snapshot, adapterEpoch);
  if (search === pendingByPath.get(path)?.base) {
    // A write back to the base query: the router discards the unlanded writes
    // that led away from it, so nothing is pending and the snapshot is the truth.
    pendingByPath.delete(path);
    notifyPendingSearch(path);
    return;
  }
  const pending = pendingByPath.get(path) ?? {
    base: snapshot,
    epoch: hostEpoch(adapterEpoch),
    queue: [],
  };
  // A write back to a query already queued: the router discards every
  // unlanded write but the last, so the entries after the earlier one never
  // land and must not be mistaken for a later outside navigation.
  const repeatedAt = pending.queue.indexOf(search);
  const queue =
    repeatedAt === -1
      ? [...pending.queue, search]
      : pending.queue.slice(0, repeatedAt + 1);
  pendingByPath.set(path, { ...pending, queue });
  notifyPendingSearch(path);
}

/**
 * Holds a path's pending writes only while a writer for it is mounted. Leaving
 * the route unmounts its writers, so a write the router never reflected cannot
 * shadow the snapshot when the reader returns. The release waits one microtask
 * so a development double mount, whose cleanup and re-run share one task,
 * keeps a write made while mounting. Returns the release function.
 */
export function retainPendingSearchWrites(path: string): () => void {
  writersByPath.set(path, (writersByPath.get(path) ?? 0) + 1);
  retainPopstateCounter();
  return () => {
    releasePopstateCounter();
    writersByPath.set(path, (writersByPath.get(path) ?? 1) - 1);
    queueMicrotask(() => {
      if ((writersByPath.get(path) ?? 0) > 0) {
        return;
      }
      writersByPath.delete(path);
      pendingByPath.delete(path);
      notifyPendingSearch(path);
    });
  };
}

function resolvePending(
  pending: PendingSearch,
  snapshot: string,
  adapterEpoch: number | null
): PendingSearch {
  const epoch = hostEpoch(adapterEpoch);
  if (snapshot === pending.base) {
    return sameEpoch(pending.epoch, epoch)
      ? pending
      : { ...pending, queue: [] };
  }
  const landedAt = pending.queue.lastIndexOf(snapshot);
  if (landedAt === -1) {
    return { ...pending, queue: [] };
  }
  return {
    ...pending,
    base: snapshot,
    epoch,
    queue: pending.queue.slice(landedAt + 1),
  };
}

function hostEpoch(adapterEpoch: number | null): HostEpoch {
  return {
    adapter: adapterEpoch,
    popstates: adapterEpoch === null ? popstateCount : 0,
  };
}

function sameEpoch(left: HostEpoch, right: HostEpoch): boolean {
  return left.adapter === right.adapter && left.popstates === right.popstates;
}

let popstateCount = 0;
let popstateListeners = 0;

function countPopstate() {
  popstateCount += 1;
}

function retainPopstateCounter() {
  popstateListeners += 1;
  if (popstateListeners === 1) {
    globalThis.window?.addEventListener("popstate", countPopstate);
  }
}

function releasePopstateCounter() {
  popstateListeners -= 1;
  if (popstateListeners === 0) {
    globalThis.window?.removeEventListener("popstate", countPopstate);
  }
}
