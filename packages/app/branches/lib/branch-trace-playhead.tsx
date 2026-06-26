"use client";

import type { MergedTraceItem } from "@repo/api/src/types/branch";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Shared playhead controller (Epic E / E2) — the contract that breaks the
 * timeline↔trace import cycle. Both E1's scrubber and D2's combined merged-trace
 * bind to ONE controller via context; neither imports the other. The controller
 * is the single source of truth for `activeTimestamp` / `activeRow` /
 * `activeHourStart`, cross-deriving each axis through pure index helpers.
 */
const HOUR_MS = 3_600_000;

export type BranchTraceTimeIndexEntry = { row: number; t: string; tMs: number };

export type BranchPlayheadController = {
  activeTimestamp: string | null;
  activeRow: number | null;
  /** `activeTimestamp` truncated to the hour — matches E1's bar granularity. */
  activeHourStart: string | null;
  /** Timeline/scrubber-driven: set active time, derive nearest trace row. */
  scrubToTimestamp(t: string): void;
  /** Trace-driven: set active row, derive its timestamp (no scroll feedback). */
  scrubToRow(row: number): void;
  /** Subscribe to timeline-driven scrubs so the trace can scroll to the row. */
  registerTraceScroll(onActive: (row: number) => void): () => void;
};

/** Sorted time index over trace items; items without a parseable `t` (e.g. `end`) are skipped. */
export function buildTraceTimeIndex(
  items: readonly MergedTraceItem[]
): BranchTraceTimeIndexEntry[] {
  const index: BranchTraceTimeIndexEntry[] = [];
  items.forEach((item, row) => {
    if ("t" in item && typeof item.t === "string") {
      const tMs = Date.parse(item.t);
      if (!Number.isNaN(tMs)) {
        index.push({ row, t: item.t, tMs });
      }
    }
  });
  index.sort((a, b) => a.tMs - b.tMs);
  return index;
}

/** Nearest trace row to a timestamp (binary search); clamps out-of-range, null when empty. */
export function nearestRowForTimestamp(
  index: readonly BranchTraceTimeIndexEntry[],
  t: string
): number | null {
  const first = index[0];
  const last = index.at(-1);
  if (first === undefined || last === undefined) {
    return null;
  }
  const target = Date.parse(t);
  if (Number.isNaN(target)) {
    return null;
  }
  if (target <= first.tMs) {
    return first.row;
  }
  if (target >= last.tMs) {
    return last.row;
  }
  let lo = 0;
  let hi = index.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const entry = index[mid];
    if (entry === undefined) {
      break;
    }
    if (entry.tMs === target) {
      return entry.row;
    }
    if (entry.tMs < target) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const after = index[lo];
  const before = index[hi];
  if (after === undefined) {
    return before?.row ?? null;
  }
  if (before === undefined) {
    return after.row;
  }
  return Math.abs(after.tMs - target) < Math.abs(target - before.tMs)
    ? after.row
    : before.row;
}

/** Timestamp for a given trace row; null when the row is not in the index. */
export function nearestTimestampForRow(
  index: readonly BranchTraceTimeIndexEntry[],
  row: number
): string | null {
  return index.find((entry) => entry.row === row)?.t ?? null;
}

/** Truncate an ISO timestamp to the hour (matching E1's `hourStart`). */
export function truncateToHourIso(t: string | null): string | null {
  if (t == null) {
    return null;
  }
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) {
    return null;
  }
  return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString();
}

const PlayheadContext = createContext<BranchPlayheadController | null>(null);

export type BranchTracePlayheadProviderProps = {
  traceItems: readonly MergedTraceItem[];
  children: ReactNode;
};

export function BranchTracePlayheadProvider({
  traceItems,
  children,
}: BranchTracePlayheadProviderProps) {
  const [activeTimestamp, setActiveTimestamp] = useState<string | null>(null);
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const index = useMemo(() => buildTraceTimeIndex(traceItems), [traceItems]);
  const scrollListeners = useRef(new Set<(row: number) => void>());

  // Reset the active scrub when the trace identity changes — e.g. navigating to
  // a different branch while this provider stays mounted — so a stale row/hour
  // from the previous trace never highlights against the new one. Done during
  // render (React's "adjust state on prop change" pattern) to avoid painting a
  // stale frame. Identical data keeps the same array reference (TanStack
  // structural sharing), so benign background refetches don't clobber a scrub.
  const prevItemsRef = useRef(traceItems);
  if (prevItemsRef.current !== traceItems) {
    prevItemsRef.current = traceItems;
    if (activeTimestamp !== null) {
      setActiveTimestamp(null);
    }
    if (activeRow !== null) {
      setActiveRow(null);
    }
  }

  const scrubToTimestamp = useCallback(
    (t: string) => {
      const row = nearestRowForTimestamp(index, t);
      setActiveTimestamp(t);
      setActiveRow(row);
      if (row != null) {
        for (const listener of scrollListeners.current) {
          listener(row);
        }
      }
    },
    [index]
  );

  const scrubToRow = useCallback(
    (row: number) => {
      const t = nearestTimestampForRow(index, row);
      setActiveRow(row);
      if (t != null) {
        setActiveTimestamp(t);
      }
    },
    [index]
  );

  const registerTraceScroll = useCallback((onActive: (row: number) => void) => {
    scrollListeners.current.add(onActive);
    return () => {
      scrollListeners.current.delete(onActive);
    };
  }, []);

  const controller = useMemo<BranchPlayheadController>(
    () => ({
      activeTimestamp,
      activeRow,
      activeHourStart: truncateToHourIso(activeTimestamp),
      scrubToTimestamp,
      scrubToRow,
      registerTraceScroll,
    }),
    [
      activeTimestamp,
      activeRow,
      scrubToTimestamp,
      scrubToRow,
      registerTraceScroll,
    ]
  );

  return (
    <PlayheadContext.Provider value={controller}>
      {children}
    </PlayheadContext.Provider>
  );
}

export function useBranchTracePlayhead(): BranchPlayheadController {
  const controller = useContext(PlayheadContext);
  if (controller == null) {
    throw new Error(
      "useBranchTracePlayhead must be used within a BranchTracePlayheadProvider"
    );
  }
  return controller;
}
