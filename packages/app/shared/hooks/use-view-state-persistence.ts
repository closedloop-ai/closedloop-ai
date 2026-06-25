"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocalStorageState } from "./use-local-storage-state";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Stable key for the localStorage hook when persistence is disabled (key is
// null). The hook ignores the stored value in memory mode, so nothing is
// actually written.
const NOOP_KEY = "__view-state-noop__";

type Envelope<T> = {
  savedAt: number;
  data: T;
};

type UseViewStatePersistenceOptions<T> = {
  ttlMs?: number;
  validate?: (data: T) => T;
};

function isValidEnvelope<T>(value: unknown): value is Envelope<T> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    "savedAt" in record &&
    typeof record.savedAt === "number" &&
    Number.isFinite(record.savedAt) &&
    "data" in record
  );
}

export function useViewStatePersistence<T>(
  key: string | null,
  defaultValue: T,
  options?: UseViewStatePersistenceOptions<T>
): [T, (value: T | ((prev: T) => T)) => void, () => void] {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const validate = options?.validate;
  const useMemory = key === null;

  const [memoryState, setMemoryState] = useState(defaultValue);
  const [envelope, setEnvelope] = useLocalStorageState<Envelope<T> | null>(
    key ?? NOOP_KEY,
    null
  );

  const isValid =
    !useMemory &&
    isValidEnvelope(envelope) &&
    Date.now() - envelope.savedAt <= ttlMs;
  let persistedValue = defaultValue;
  if (isValid) {
    persistedValue = validate ? validate(envelope.data) : envelope.data;
  }

  useEffect(() => {
    if (
      !useMemory &&
      isValidEnvelope(envelope) &&
      Date.now() - envelope.savedAt > ttlMs
    ) {
      setEnvelope(null);
    }
  }, [useMemory, envelope, ttlMs, setEnvelope]);

  const setPersistedValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      setEnvelope((prev) => {
        let current = defaultValue;
        if (isValidEnvelope(prev) && Date.now() - prev.savedAt <= ttlMs) {
          current = validate ? validate(prev.data) : prev.data;
        }
        const newValue =
          typeof next === "function" ? (next as (prev: T) => T)(current) : next;
        return { savedAt: Date.now(), data: newValue };
      });
    },
    [ttlMs, validate, defaultValue, setEnvelope]
  );

  const clearMemory = useCallback(() => {
    setMemoryState(defaultValue);
  }, [defaultValue]);

  const clearPersisted = useCallback(() => {
    setEnvelope(null);
  }, [setEnvelope]);

  if (useMemory) {
    return [memoryState, setMemoryState, clearMemory];
  }
  return [persistedValue, setPersistedValue, clearPersisted];
}

export function reviveDates<T extends Record<string, unknown>>(
  data: T,
  dateFields: (keyof T)[]
): T {
  const result = { ...data };
  for (const field of dateFields) {
    const value = result[field];
    if (typeof value === "string") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        (result as Record<string, unknown>)[field as string] = parsed;
      }
    }
  }
  return result;
}
