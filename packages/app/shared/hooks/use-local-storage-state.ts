"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";

// Sentinel to distinguish "never read" from "read but key absent" (null).
const UNINITIALIZED = Symbol("uninitialized");

/**
 * A generic state hook backed by localStorage, safe for SSR.
 * Uses useSyncExternalStore to avoid hydration mismatches.
 * Values are JSON-serialized for storage.
 */
export function useLocalStorageState<T>(
  key: string,
  defaultValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  const defaultRef = useRef(defaultValue);
  defaultRef.current = defaultValue;

  // Cache the raw string and parsed value so getSnapshot returns a stable
  // reference for non-primitive types (required by useSyncExternalStore).
  const cacheRef = useRef<{
    raw: typeof UNINITIALIZED | string | null;
    parsed: T;
  }>({
    raw: UNINITIALIZED,
    parsed: defaultValue,
  });

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const handler = (e: StorageEvent) => {
        if (e.key === key) {
          onStoreChange();
        }
      };
      globalThis.addEventListener("storage", handler);
      return () => globalThis.removeEventListener("storage", handler);
    },
    [key]
  );

  const deserialize = useCallback((raw: string | null): T => {
    if (raw === null) {
      return defaultRef.current;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return defaultRef.current;
    }
  }, []);

  const getSnapshot = useCallback(() => {
    let raw: string | null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      return defaultRef.current;
    }
    if (raw !== cacheRef.current.raw) {
      cacheRef.current = { raw, parsed: deserialize(raw) };
    }
    return cacheRef.current.parsed;
  }, [key, deserialize]);

  const getServerSnapshot = useCallback(() => defaultRef.current, []);

  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      let current: T;
      try {
        current = deserialize(localStorage.getItem(key));
      } catch {
        current = defaultRef.current;
      }
      const newValue =
        typeof next === "function" ? (next as (prev: T) => T)(current) : next;
      const serialized = JSON.stringify(newValue);
      try {
        localStorage.setItem(key, serialized);
      } catch {
        return;
      }
      const event = new StorageEvent("storage", {
        key,
        newValue: serialized,
      });
      // StorageEvent constructor doesn't accept storageArea in all environments
      // (e.g. jsdom), so assign it separately for spec-compliant listeners.
      try {
        Object.defineProperty(event, "storageArea", { value: localStorage });
      } catch {
        // Non-critical; same-window dispatch works without it.
      }
      globalThis.dispatchEvent(event);
    },
    [key, deserialize]
  );

  return [value, setValue];
}
