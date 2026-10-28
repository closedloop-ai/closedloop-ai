/**
 * Fixture data and the pure sort/group model behind `grid-table-v2.stories.tsx`
 * (ISS-8490).
 *
 * Split out of the story because that file already carries the harness AND five
 * `play` contracts; this is the other responsibility. A `.ts` under this
 * directory is not indexed as a story, so nothing here is collected twice.
 */

import type {
  GridTableV2Column,
  GridTableV2Group,
} from "@repo/design-system/components/ui/grid-table-v2";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";

export type GridStoryRow = {
  /** A magnitude, right-aligned by its kind so the decimals line up (ISS-9821). */
  cost: string;
  /** A numeric LABEL — an ordinal, not a quantity, so it reads at the leading edge. */
  runNumber: string;
  id: string;
  owner: string;
  slug: string;
  status: string;
  title: string;
  type: string;
  /** The rendered date string. */
  updated: string;
  /** Sortable form of `updated`. */
  updatedAt: string;
};

export const LEAD_COLUMN_WIDTH_PX = 280;
export const DATA_COLUMN_WIDTH_PX = 180;

export const COLUMNS: readonly GridTableV2Column[] = [
  { id: "type", label: "Type", sortable: true, filterable: true },
  {
    id: "status",
    label: "Status",
    sortable: true,
    filterable: true,
    groupable: true,
  },
  {
    id: "owner",
    label: "Owner",
    sortable: true,
    filterable: true,
    groupable: true,
  },
  { id: "updated", label: "Updated", sortable: true },
];

/**
 * Four rows, not three, and owners whose alphabetical order interleaves with the
 * fixture order — `PointerRangeFollowsPaintedOrder` needs a span that a
 * fixture-order slice and a painted-order slice disagree about, and with three
 * rows every such span coincides.
 */
export const ROWS: readonly GridStoryRow[] = [
  {
    cost: "$412.80",
    id: "artifact-1",
    runNumber: "#1042",
    owner: "Pascoe Birchall",
    slug: "FEA-2481",
    status: "In review",
    title: "Unified artifact experience",
    type: "Feature",
    updated: "Aug 26, 2026",
    updatedAt: "2026-08-26",
  },
  {
    cost: "$97.15",
    id: "artifact-2",
    runNumber: "#87",
    owner: "Ottilie Eastwick",
    slug: "FEA-2477",
    status: "Active",
    title: "Canonical table controls",
    type: "Document",
    updated: "Aug 25, 2026",
    updatedAt: "2026-08-25",
  },
  {
    cost: "$1,204.00",
    id: "artifact-3",
    runNumber: "#5",
    owner: "Sam Chen",
    slug: "ISS-4382",
    status: "Draft",
    title: "Portable Sessions surface",
    type: "Session",
    updated: "Aug 24, 2026",
    updatedAt: "2026-08-24",
  },
  {
    cost: "$36.42",
    id: "artifact-4",
    runNumber: "#310",
    owner: "Dana Wu",
    slug: "ISS-4390",
    status: "Active",
    title: "Grid keyboard parity",
    type: "Feature",
    updated: "Aug 23, 2026",
    updatedAt: "2026-08-23",
  },
];

export const FIXTURE_ORDER = ROWS.map(({ id }) => id);
/** Ottilie Eastwick, Dana Wu, Pascoe Birchall, Sam Chen. */
export const OWNER_ASCENDING_ORDER = [
  "artifact-2",
  "artifact-4",
  "artifact-1",
  "artifact-3",
];

export function sortRows(
  rows: readonly GridStoryRow[],
  sortBy: string | null,
  sortDir: SortDirection
): GridStoryRow[] {
  if (!sortBy) {
    return [...rows];
  }
  const direction = sortDir === "asc" ? 1 : -1;
  return [...rows].sort(
    (left, right) =>
      sortValue(left, sortBy).localeCompare(sortValue(right, sortBy)) *
      direction
  );
}

export function buildGroups(
  rows: readonly GridStoryRow[],
  groupBy: string | null
): GridTableV2Group<GridStoryRow>[] | undefined {
  if (!groupBy) {
    return undefined;
  }
  const keys = [...new Set(rows.map((row) => sortValue(row, groupBy)))];
  return keys.map((key) => ({
    key,
    label: key,
    items: rows.filter((row) => sortValue(row, groupBy) === key),
  }));
}

/**
 * The value a column sorts and groups BY, which is not the string it renders:
 * `updated` shows "Aug 26, 2026" and would `localeCompare` a September date
 * ahead of it, so the row carries a sortable `updatedAt` and this returns that.
 */
function sortValue(row: GridStoryRow, columnId: string): string {
  if (columnId === "name") {
    return row.title;
  }
  if (columnId === "updated") {
    return row.updatedAt;
  }
  return String(row[columnId as keyof GridStoryRow] ?? "");
}

/**
 * `count` rows for a story that needs a population no reader scrolls to the end
 * of — ISS-12288's windowed body, where four rows would paint whole.
 *
 * Built by cycling {@link ROWS}, with a distinct id and ordinal per row, so
 * every row stays addressable by identity and the painted order is the
 * fixture's.
 */
export function buildLongRowFixture(count: number): readonly GridStoryRow[] {
  return Array.from({ length: count }, (_, index) => {
    const template = ROWS[index % ROWS.length];
    if (!template) {
      throw new Error("the row fixture is empty, so there is nothing to cycle");
    }
    return {
      ...template,
      id: `artifact-long-${index + 1}`,
      runNumber: `#${index + 1}`,
      title: `${template.title} ${index + 1}`,
    };
  });
}
