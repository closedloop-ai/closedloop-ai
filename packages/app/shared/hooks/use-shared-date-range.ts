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

export type SharedDateRangeState<Range extends DateRange = DateRange> = {
  dateRange: Range;
  setDateRange: (range: Range) => void;
};

export function useSharedDateRange(
  surface: string,
  defaultRange?: DateRange
): SharedDateRangeState<DateRange>;
/**
 * A narrower surface (the insights dashboard) passes the ranges it can answer
 * and gets that narrower union back, so the admitted set and the result type
 * cannot drift apart. A stored value outside the set resolves to the default
 * exactly like an unrecognised one.
 */
export function useSharedDateRange<Range extends DateRange>(
  surface: string,
  defaultRange: Range | undefined,
  ranges: readonly Range[]
): SharedDateRangeState<Range>;
export function useSharedDateRange(
  surface: string,
  defaultRange: DateRange = DEFAULT_RANGE,
  ranges: readonly DateRange[] = DATE_RANGES
): SharedDateRangeState<DateRange> {
  const migrated = useRef(false);
  if (!migrated.current) {
    migrated.current = true;
    migrateLegacyKey(surface);
  }

  const [raw, setRaw] = useLocalStorageState<string>(
    storageKey(surface),
    defaultRange
  );

  const dateRange = ranges.find((range) => range === raw) ?? defaultRange;

  const setDateRange = useCallback(
    (range: DateRange) => {
      setRaw(range);
    },
    [setRaw]
  );

  return { dateRange, setDateRange };
}
