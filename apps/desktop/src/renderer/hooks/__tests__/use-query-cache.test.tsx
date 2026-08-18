/**
 * ISS-5301: the shared in-memory query cache behind the legacy desktop views.
 *
 * Three behaviors here are load-bearing and none of them are visible from a
 * single happy-path mount: the TTL decides whether a second consumer pays for
 * another IPC round trip at all, the `db:`-prefixed keys subscribe to
 * main-process change pushes, and those pushes are COALESCED so a startup or
 * import burst does not refetch every mounted view at once. Time is pinned with
 * fake timers throughout — the TTL and the coalescing window are both clock
 * boundaries — so settling is driven by `flush()` rather than `waitFor`, whose
 * own polling would never advance against a frozen clock.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateCache, useQueryCache } from "../useQueryCache";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

/** Distinct per test so the module-level cache cannot leak across cases. */
let keySeq = 0;
function nextKey(prefix: string): string {
  keySeq += 1;
  return `${prefix}:iss5301-${keySeq}`;
}

/** Settle pending promise callbacks (and any timer due) inside `act`. */
async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function installDbChanged(
  onDbChanged?: (listener: () => void) => () => void
): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: onDbChanged ? { onDbChanged } : {},
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-13T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("useQueryCache — fetching", () => {
  it("fetches on mount and exposes the resolved data", async () => {
    const key = nextKey("mem");
    const fetcher = vi.fn().mockResolvedValue({ count: 7 });

    const { result } = renderHook(() => useQueryCache(key, fetcher));
    expect(result.current.loading).toBe(true);

    await flush();

    expect(result.current.data).toEqual({ count: 7 });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);

    invalidateCache(key);
  });

  it("reports an error without leaving the consumer stuck loading", async () => {
    const key = nextKey("mem");
    const fetcher = vi.fn().mockRejectedValue(new Error("ipc down"));

    const { result } = renderHook(() => useQueryCache(key, fetcher));
    await flush();

    expect(result.current.error).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();

    invalidateCache(key);
  });

  it("serves a second consumer from cache inside the TTL instead of re-fetching", async () => {
    const key = nextKey("mem");
    const first = vi.fn().mockResolvedValue({ count: 1 });
    renderHook(() => useQueryCache(key, first));
    await flush();

    const second = vi.fn().mockResolvedValue({ count: 999 });
    const { result } = renderHook(() => useQueryCache(key, second));
    await flush();

    // Seeded straight from the cache: no second round trip, no loading flash.
    expect(result.current.data).toEqual({ count: 1 });
    expect(second).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);

    invalidateCache(key);
  });

  it("re-fetches once the cached value ages past the TTL", async () => {
    const key = nextKey("mem");
    const first = vi.fn().mockResolvedValue({ count: 1 });
    renderHook(() => useQueryCache(key, first, 3000));
    await flush();

    vi.setSystemTime(new Date("2026-08-13T12:00:04.000Z"));

    const second = vi.fn().mockResolvedValue({ count: 2 });
    const { result } = renderHook(() => useQueryCache(key, second, 3000));
    await flush();

    expect(result.current.data).toEqual({ count: 2 });
    expect(second).toHaveBeenCalledTimes(1);

    invalidateCache(key);
  });

  it("polls on the requested interval and stops on unmount", async () => {
    const key = nextKey("mem");
    const fetcher = vi.fn().mockResolvedValue({ count: 1 });

    // ttl 0 so every poll tick is a genuine miss rather than a cache hit.
    const { unmount } = renderHook(() => useQueryCache(key, fetcher, 0, 1000));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await flush(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);

    unmount();
    await flush(5000);
    expect(fetcher).toHaveBeenCalledTimes(2);

    invalidateCache(key);
  });
});

describe("useQueryCache — live db: change pushes", () => {
  it("subscribes only for db:-prefixed keys", async () => {
    const onDbChanged = vi.fn(() => vi.fn());
    installDbChanged(onDbChanged);

    const memKey = nextKey("mem");
    renderHook(() => useQueryCache(memKey, vi.fn().mockResolvedValue(1)));
    await flush();

    expect(onDbChanged).not.toHaveBeenCalled();
    invalidateCache(memKey);
  });

  it("drops the cached value and reloads when the main process pushes a change", async () => {
    let listener: (() => void) | null = null;
    installDbChanged((fn) => {
      listener = fn;
      return vi.fn();
    });

    const key = nextKey("db");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ rows: 1 })
      .mockResolvedValue({ rows: 2 });

    const { result } = renderHook(() => useQueryCache(key, fetcher));
    await flush();
    expect(result.current.data).toEqual({ rows: 1 });

    act(() => {
      listener?.();
    });
    await flush(500);

    expect(result.current.data).toEqual({ rows: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);

    invalidateCache(key);
  });

  it("coalesces a burst of pushes into one reload", async () => {
    let listener: (() => void) | null = null;
    installDbChanged((fn) => {
      listener = fn;
      return vi.fn();
    });

    const key = nextKey("db");
    const fetcher = vi.fn().mockResolvedValue({ rows: 1 });
    renderHook(() => useQueryCache(key, fetcher));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // A startup/import burst: many pushes inside the coalescing window.
    act(() => {
      listener?.();
      listener?.();
      listener?.();
    });
    await flush(500);

    // One reload, not three.
    expect(fetcher).toHaveBeenCalledTimes(2);

    invalidateCache(key);
  });

  it("unsubscribes and cancels an armed reload on unmount", async () => {
    let listener: (() => void) | null = null;
    const unsubscribe = vi.fn();
    installDbChanged((fn) => {
      listener = fn;
      return unsubscribe;
    });

    const key = nextKey("db");
    const fetcher = vi.fn().mockResolvedValue({ rows: 1 });
    const { unmount } = renderHook(() => useQueryCache(key, fetcher));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    act(() => {
      listener?.();
    });
    unmount();
    await flush(2000);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    // The armed coalesce timer was cleared, so no reload ran after teardown.
    expect(fetcher).toHaveBeenCalledTimes(1);

    invalidateCache(key);
  });

  it("skips the subscription when the preload bridge has no onDbChanged", async () => {
    installDbChanged();

    const key = nextKey("db");
    const fetcher = vi.fn().mockResolvedValue({ rows: 1 });
    const { result } = renderHook(() => useQueryCache(key, fetcher));
    await flush();

    expect(result.current.data).toEqual({ rows: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);

    invalidateCache(key);
  });
});

describe("invalidateCache", () => {
  it("forces the next consumer to re-fetch inside the TTL", async () => {
    const key = nextKey("mem");
    const first = vi.fn().mockResolvedValue({ count: 1 });
    renderHook(() => useQueryCache(key, first));
    await flush();

    invalidateCache(key);

    const second = vi.fn().mockResolvedValue({ count: 2 });
    const { result } = renderHook(() => useQueryCache(key, second));
    await flush();

    expect(result.current.data).toEqual({ count: 2 });
    expect(second).toHaveBeenCalledTimes(1);

    invalidateCache(key);
  });
});
