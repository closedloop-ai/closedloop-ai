"use client";

import { useCallback, useRef } from "react";
import { z } from "zod";
import {
  DATE_RANGES,
  type DateRange,
  DEFAULT_DATE_RANGE,
} from "../lib/format-utils";
import { useLocalStorageState } from "./use-local-storage-state";

const DEFAULT_RANGE: DateRange = DEFAULT_DATE_RANGE;
const rangeSchema = z.enum(DATE_RANGES);

function storageKey(surface: string): string {
  return `shared:date-range:${surface}`;
}

function migrateLegacyKey(surface: string): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    const key = storageKey(surface);
    if (localStorage.getItem(key) !== null) {
      return;
    }

    const legacyKey = `insights:dashboard-range:${surface}`;
    const legacy = localStorage.getItem(legacyKey);
    if (legacy) {
      const result = rangeSchema.safeParse(legacy);
      if (result.success) {
        localStorage.setItem(key, JSON.stringify(result.data));
      }
    }
  } catch {
    // Private mode / quota — migration is best-effort.
  }
}

export type SharedDateRangeState = {
  dateRange: DateRange;
  setDateRange: (range: DateRange) => void;
};

export function useSharedDateRange(
  surface: string,
  defaultRange: DateRange = DEFAULT_RANGE
): SharedDateRangeState {
  const migrated = useRef(false);
  if (!migrated.current) {
    migrated.current = true;
    migrateLegacyKey(surface);
  }

  const [raw, setRaw] = useLocalStorageState<string>(
    storageKey(surface),
    defaultRange
  );

  const parsed = rangeSchema.safeParse(raw);
  const dateRange: DateRange = parsed.success ? parsed.data : defaultRange;

  const setDateRange = useCallback(
    (range: DateRange) => {
      setRaw(range);
    },
    [setRaw]
  );

  return { dateRange, setDateRange };
}
