/** ISS-12048: browser, server and Desktop main flags checked for this page. */

const MAX_CHECKED_KEYS = 1000;
const MAX_CACHED_PAGES = 50;

let checked: ReadonlySet<string> = new Set();
let pageReads = new Set<string>();
let currentPage: string | null = null;
let persistentKeys: ReadonlySet<string> = new Set();
const mountedBrowserFlags = new Map<string, number>();
const serverKeysByPage = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();

/** Record a read made on the current page. */
export function recordCheckedFeatureFlags(keys: Iterable<string>): void {
  addKeys(pageReads, keys);
  rebuildChecked();
}

/** Keep a mounted browser flag available after navigation without carrying old page flags. */
export function registerMountedCheckedFeatureFlag(flag: string): () => void {
  if (
    flag.length === 0 ||
    (!mountedBrowserFlags.has(flag) &&
      mountedBrowserFlags.size >= MAX_CHECKED_KEYS)
  ) {
    return () => undefined;
  }
  mountedBrowserFlags.set(flag, (mountedBrowserFlags.get(flag) ?? 0) + 1);
  recordCheckedFeatureFlags([flag]);
  return () => {
    const count = mountedBrowserFlags.get(flag);
    if (count === 1) {
      mountedBrowserFlags.delete(flag);
    } else if (count !== undefined) {
      mountedBrowserFlags.set(flag, count - 1);
    }
  };
}

/** Cache a request's checked keys by route so a cached page can show them again. */
export function recordServerCheckedFeatureFlags(
  page: string,
  keys: Iterable<string>
): void {
  currentPage ??= page;
  const next = new Set(serverKeysByPage.get(page));
  addKeys(next, keys);
  serverKeysByPage.delete(page);
  serverKeysByPage.set(page, next);
  if (serverKeysByPage.size > MAX_CACHED_PAGES) {
    const oldest = serverKeysByPage.keys().next().value;
    if (oldest !== undefined) {
      serverKeysByPage.delete(oldest);
    }
  }
  if (page === currentPage) {
    rebuildChecked();
  }
}

/** Replace the Desktop main keys, which belong to the whole signed-in shell. */
export function setPersistentCheckedFeatureFlags(keys: Iterable<string>): void {
  const next = new Set<string>();
  addKeys(next, keys);
  persistentKeys = next;
  rebuildChecked();
}

/** A route change retains mounted shell reads and restores that route's server reads. */
export function resetCheckedFeatureFlags(page?: string): void {
  if (page === undefined) {
    currentPage = null;
    pageReads = new Set();
    persistentKeys = new Set();
    mountedBrowserFlags.clear();
    serverKeysByPage.clear();
  } else {
    currentPage = page;
    pageReads = new Set(mountedBrowserFlags.keys());
  }
  rebuildChecked();
}

/** The current record. Its identity changes only when its contents do. */
export function readCheckedFeatureFlags(): ReadonlySet<string> {
  return checked;
}

export function subscribeToCheckedFeatureFlags(
  listener: () => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function addKeys(target: Set<string>, keys: Iterable<string>): void {
  for (const key of keys) {
    if (key.length === 0 || target.has(key)) {
      continue;
    }
    if (target.size >= MAX_CHECKED_KEYS) {
      break;
    }
    target.add(key);
  }
}

function rebuildChecked(): void {
  const next = new Set<string>();
  addKeys(next, pageReads);
  addKeys(next, mountedBrowserFlags.keys());
  addKeys(next, persistentKeys);
  if (currentPage !== null) {
    addKeys(next, serverKeysByPage.get(currentPage) ?? []);
  }
  if (
    next.size === checked.size &&
    [...next].every((key) => checked.has(key))
  ) {
    return;
  }
  checked = next;
  for (const listener of listeners) {
    listener();
  }
}
