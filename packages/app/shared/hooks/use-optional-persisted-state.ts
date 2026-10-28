"use client";

import { useState } from "react";
import { useLocalStorageState } from "./use-local-storage-state";

// Stable key for the localStorage hook in memory mode. Nothing is read back
// from it and no setter that writes to it is ever returned, so it stays empty.
const NOOP_KEY = "__optional-persisted-state-noop__";

/**
 * `useLocalStorageState` with a nullable key: `null` holds the value in memory
 * and persists nothing (ISS-9726 — the active organization has not resolved, so
 * there is no key the value can honestly be written under).
 *
 * Extracted because three call sites needed the same shape and were about to
 * spell it out three times. Both branches are always evaluated — React forbids a
 * conditional hook — and the unused one is discarded, which is why the memory
 * branch must not do work proportional to anything.
 *
 * NOT a replacement for {@link useViewStatePersistence}, which wraps its value
 * in a `savedAt` envelope and expires it after a TTL. This one is for a DURABLE
 * preference (column visibility, column order, group expansion) that must not
 * quietly vanish after a week.
 */
export function useOptionalPersistedState<T>(
  key: string | null,
  defaultValue: T,
  validate?: (value: unknown, fallback: T) => T
): [T, (value: T | ((prev: T) => T)) => void] {
  const [memoryValue, setMemoryValue] = useState<T>(defaultValue);
  const [persistedValue, setPersistedValue] = useLocalStorageState<T>(
    key ?? NOOP_KEY,
    defaultValue,
    validate
  );
  if (key === null) {
    return [memoryValue, setMemoryValue];
  }
  return [persistedValue, setPersistedValue];
}
