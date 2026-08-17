import { vi } from "vitest";

/**
 * Back `globalThis.localStorage` with an in-memory store for the duration of a
 * renderer suite.
 *
 * The renderer test environment ships no real `localStorage`, but the first-run
 * flags in `dashboard-storage-keys` gate the whole first-launch flow — the
 * landing takeover, the dashboard reveal and the guided tour all read or write
 * one. Without a backing store `readFlag`/`writeFlag` silently no-op through
 * their own null guard, so a suite would exercise the "storage unavailable"
 * branch while appearing to test the flags.
 *
 * Extracted when the onboarding suite needed the same fixture the dashboard
 * suite already had. Call from `beforeEach`; `vi.unstubAllGlobals` (or the next
 * call) undoes it.
 */
export function stubLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  });
}
