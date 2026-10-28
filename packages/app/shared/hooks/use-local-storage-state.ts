"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";
import { subscribeToStorageKey } from "./subscribe-to-storage-key";

// Sentinel to distinguish "never read" from "read but key absent" (null).
const UNINITIALIZED = Symbol("uninitialized");

/**
 * A generic state hook backed by localStorage, safe for SSR.
 * Uses useSyncExternalStore to avoid hydration mismatches.
 * Values are JSON-serialized for storage.
 *
 * @param validate - Optional coercer for the PARSED STORED value (ISS-8533). Without
 *   it the stored bytes reach the caller under a bare `as T`, so a well-formed JSON
 *   scalar is typed as something it is not. It is never applied to `defaultValue`, and
 *   never when `JSON.parse` throws. Coercers live in `shared/lib/local-storage-validators`.
 *
 *   Three requirements, none of which the type can express:
 *   - **Pure in `(value, fallback)`.** The result is cached against the raw string, so
 *     a validator closing over changing state returns a stale value forever, silently.
 *   - **Content-preserving for every valid `T`.** `setValue` dispatches a `StorageEvent`,
 *     so the next snapshot re-parses and RE-VALIDATES what was just written; a
 *     normalizing validator (trim, sort, dedupe) makes the rendered value differ from
 *     the value written.
 *   - **A content-stable `defaultValue`.** A validator's fallback is cached against the
 *     raw string, so a default whose CONTENT moves is not picked up while those bytes
 *     stay put. Referential churn is fine — only the value matters. This does NOT
 *     contradict the absent-key note below: that branch returns the live default and is
 *     untouched. This one is about a stored-but-malformed value.
 *
 *   A validator that throws propagates on both the read and the write path — it is a
 *   bug in our code, not bad data, and must not be swallowed into a persisted default.
 *
 *   Distinct from {@link useViewStatePersistence}'s one-argument `validate`, which runs
 *   on already-envelope-checked data rather than raw `JSON.parse` output.
 */
export function useLocalStorageState<T>(
  key: string,
  defaultValue: T,
  validate?: (value: unknown, fallback: T) => T
): [T, (value: T | ((prev: T) => T)) => void] {
  const defaultRef = useRef(defaultValue);
  defaultRef.current = defaultValue;
  const validateRef = useRef(validate);
  validateRef.current = validate;

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
    (onStoreChange: () => void) => subscribeToStorageKey(key, onStoreChange),
    [key]
  );

  const deserialize = useCallback((raw: string | null): T => {
    if (raw === null) {
      return defaultRef.current;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return defaultRef.current;
    }
    // Outside the catch on purpose: a validator that throws is our bug, not bad data,
    // so it propagates instead of being silently converted into the default.
    const validateStored = validateRef.current;
    return validateStored
      ? validateStored(parsed, defaultRef.current)
      : (parsed as T);
  }, []);

  const getSnapshot = useCallback(() => {
    let raw: string | null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      return defaultRef.current;
    }
    // An absent key means the caller's current default, not the default from
    // the first render. Feature-gated surfaces can legitimately change their
    // default after asynchronous flag hydration without persisting a choice.
    if (raw === null) {
      cacheRef.current.raw = null;
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
      // The catch wraps ONLY the storage read. Wrapping `deserialize` too would
      // swallow a throwing validator and then PERSIST the default below. Without a
      // validator `deserialize` has no reachable throw (it catches its own
      // `JSON.parse`), so this is behaviourally identical for every caller that
      // passes none.
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(key);
      } catch {
        raw = null;
      }
      const current = deserialize(raw);
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
