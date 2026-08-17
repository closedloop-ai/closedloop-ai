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
 * `parseBranchSavedView` is pure (and unit-tested); `useBranchViewState` wraps it
 * via the shared `usePersistedTableViewState`, whose `localStorage` load/save is
 * fail-soft (private mode, malformed JSON, unknown enum values all degrade to
 * `null`/no-op rather than throwing).
 */
export type BranchSavedView = {
  sortKey: BranchSortKey;
  sortDir: BranchSortDir;
  dateRange: DateRange;
  hiddenColumns: string[];
  /** FEA-4021: persisted data-column order (ids). Empty ⇒ natural order. */
  columnOrder: string[];
  /** FEA-4168: persisted per-column widths (px), keyed by id. Empty ⇒ natural. */
  columnWidths: Record<string, number>;
};

const SORT_KEYS = Object.values(SortKey) as [BranchSortKey, ...BranchSortKey[]];
const SORT_DIRS = Object.values(SortDir) as [BranchSortDir, ...BranchSortDir[]];

const branchSavedViewSchema = z.object({
  sortKey: z.enum(SORT_KEYS),
  sortDir: z.enum(SORT_DIRS),
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
  // FEA-4021: same data-cleaning preprocess as `hiddenColumns` — keep only the
  // string entries; a missing/non-array value degrades to the natural order.
  columnOrder: z
    .preprocess(
      (value) =>
        Array.isArray(value)
          ? value.filter((item) => typeof item === "string")
          : [],
      z.array(z.string())
    )
    .default([]),
  // FEA-4168: per-column widths (px), keyed by column id. Data-cleaning
  // preprocess keeps only entries with a finite positive number value; a
  // missing/non-object value degrades to {} (the table's natural widths).
  columnWidths: z
    .preprocess(cleanColumnWidths, z.record(z.string(), z.number()))
    .default({}),
});

// Keep only `{ [id]: number }` entries whose value is a finite positive width;
// a missing/non-object input (or an entry with a NaN/negative/non-number width)
// degrades to an empty map so a malformed saved view falls back to natural
// widths instead of failing the whole parse.
function cleanColumnWidths(value: unknown): Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const cleaned: Record<string, number> = {};
  for (const [id, width] of Object.entries(value as Record<string, unknown>)) {
    if (typeof width === "number" && Number.isFinite(width) && width > 0) {
      cleaned[id] = width;
    }
  }
  return cleaned;
}

/** Validate untrusted parsed JSON into a `BranchSavedView`, else `null`. */
export function parseBranchSavedView(input: unknown): BranchSavedView | null {
  const result = branchSavedViewSchema.safeParse(input);
  return result.success ? result.data : null;
}
