import { z } from "zod";
import type { DateRange } from "../../shared/lib/format-utils";
import {
  type BranchSortDir,
  type BranchSortKey,
  BranchSortDir as SortDir,
  BranchSortKey as SortKey,
} from "./branch-sort-group";

/**
 * Persisted Branches view (Epic B / B5b): the toolbar dimensions (sort, hidden
 * columns) saved to renderer `localStorage` keyed by surface and restored on
 * mount. Filter persistence is deferred (filters are session-ephemeral in v1);
 * on the eventual authed/web path this won't sync server-side — acceptable for
 * the local-first desktop surface.
 *
 * `parseBranchSavedView` is pure (and unit-tested); load/save wrap it in
 * `localStorage` with full fail-soft behavior (private mode, malformed JSON,
 * unknown enum values all degrade to `null`/no-op rather than throwing).
 */
export type BranchSavedView = {
  sortKey: BranchSortKey;
  sortDir: BranchSortDir;
  dateRange: DateRange;
  hiddenColumns: string[];
};

const SORT_KEYS = Object.values(SortKey) as [BranchSortKey, ...BranchSortKey[]];
const SORT_DIRS = Object.values(SortDir) as [BranchSortDir, ...BranchSortDir[]];

const branchSavedViewSchema = z.object({
  sortKey: z.enum(SORT_KEYS),
  sortDir: z.enum(SORT_DIRS),
  // Time window for the list + summary metrics. Defaults to the last 7 days.
  dateRange: z.enum(["7d", "30d", "90d", "all"]).default("7d"),
  // Keep only the string entries of a (possibly mixed) array; a missing or
  // non-array value degrades to []. The element filter is a data-cleaning
  // preprocess, not object-shape validation (which is the schema's job).
  hiddenColumns: z
    .preprocess(
      (value) =>
        Array.isArray(value)
          ? value.filter((item) => typeof item === "string")
          : [],
      z.array(z.string())
    )
    .default([]),
});

/** Validate untrusted parsed JSON into a `BranchSavedView`, else `null`. */
export function parseBranchSavedView(input: unknown): BranchSavedView | null {
  const result = branchSavedViewSchema.safeParse(input);
  return result.success ? result.data : null;
}

function storageKey(surface: string): string {
  return `branches:saved-view:${surface}`;
}

export function loadBranchSavedView(surface: string): BranchSavedView | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  try {
    const raw = localStorage.getItem(storageKey(surface));
    return raw ? parseBranchSavedView(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveBranchSavedView(
  surface: string,
  view: BranchSavedView
): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(storageKey(surface), JSON.stringify(view));
  } catch {
    // Private mode / quota — persistence is best-effort.
  }
}
