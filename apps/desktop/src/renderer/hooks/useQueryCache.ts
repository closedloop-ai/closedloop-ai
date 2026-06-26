import { useEffect, useRef, useState } from "react";

type CacheEntry<T> = {
  data: T;
  fetchedAt: number;
};

const cache = new Map<string, CacheEntry<unknown>>();
const LIVE_DB_RELOAD_COALESCE_MS = 500;

/**
 * Simple in-memory query cache with TTL. Multiple components using the same
 * key share a single cached result and avoid redundant IPC round-trips.
 *
 * @param key    Stable cache key (e.g. "db:analytics")
 * @param fetcher  Async function that returns the data
 * @param ttlMs    How long the cached value is considered fresh (default 3 000 ms)
 * @param pollMs   Optional re-fetch interval; disabled by default so pages load once
 */
export function useQueryCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs = 3000,
  pollMs = 0
): { data: T | null; loading: boolean; error: boolean } {
  const [data, setData] = useState<T | null>(() => {
    const cached = cache.get(key) as CacheEntry<T> | undefined;
    return cached ? cached.data : null;
  });
  const [loading, setLoading] = useState(data === null);
  const [error, setError] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let mounted = true;

    const load = (showLoading = true) => {
      const existing = cache.get(key) as CacheEntry<T> | undefined;
      if (existing && Date.now() - existing.fetchedAt < ttlMs) {
        if (mounted) {
          setData(existing.data);
          setLoading(false);
        }
        return;
      }

      // No fresh cache hit; set loading so the consumer can render a loading
      // state instead of displaying stale data from a previous key.
      if (mounted && showLoading) {
        setLoading(true);
      }

      fetcherRef
        .current()
        .then((result) => {
          cache.set(key, { data: result, fetchedAt: Date.now() });
          if (mounted) {
            setData(result);
            setLoading(false);
            setError(false);
          }
        })
        .catch(() => {
          if (mounted) {
            setLoading(false);
            setError(true);
          }
        });
    };

    load();
    const interval = pollMs > 0 ? setInterval(load, pollMs) : null;

    // Live updates: the main process pushes desktop:db:changed after each
    // processed hook event. For DB-backed keys, drop the cached value and
    // coalesce reloads so startup/import bursts do not refetch every mounted
    // legacy view at once.
    let unsubscribe: (() => void) | undefined;
    let liveReloadTimer: ReturnType<typeof setTimeout> | null = null;
    if (
      key.startsWith("db:") &&
      typeof window !== "undefined" &&
      window.desktopApi?.onDbChanged
    ) {
      unsubscribe = window.desktopApi.onDbChanged(() => {
        if (liveReloadTimer !== null) {
          return;
        }
        liveReloadTimer = setTimeout(() => {
          liveReloadTimer = null;
          cache.delete(key);
          load(false);
        }, LIVE_DB_RELOAD_COALESCE_MS);
      });
    }

    return () => {
      mounted = false;
      if (interval) {
        clearInterval(interval);
      }
      if (liveReloadTimer !== null) {
        clearTimeout(liveReloadTimer);
      }
      unsubscribe?.();
    };
  }, [key, ttlMs, pollMs]);

  return { data, loading, error };
}

/** Invalidate a specific cache key (e.g. after a mutation). */
export function invalidateCache(key: string): void {
  cache.delete(key);
}
