import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { SESSION_STATUS_RANK } from "@repo/api/src/types/session-status-rank";
import {
  type SortConfig,
  sortTableData,
} from "@repo/app/shared/lib/table-utils";
import type { GridTableV2Group } from "@repo/design-system/components/ui/grid-table-v2";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { TableFiltersController } from "@repo/design-system/components/ui/table-filters";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import {
  DEFAULT_VISIBLE_COLUMN_IDS,
  DEFAULT_VISIBLE_METRIC_KEYS,
  SESSION_DATE_RANGE_DEFINITIONS,
  SESSION_SAVED_VIEWS,
  SESSION_SORT_FIELDS,
  type SessionRow,
  type SessionSortFieldId,
  SessionSortKind,
} from "./fixtures";

export type DemoViewState = {
  readonly dateRange: string;
  readonly grouping: TableGroupingState;
  readonly owners: readonly string[];
  readonly sortBy: string | null;
  readonly sortDir: SortDirection;
  readonly statuses: readonly string[];
  readonly visibleColumnIds: readonly string[];
  readonly visibleMetricKeys: readonly string[];
};

export type DemoViewStateInput = Omit<
  DemoViewState,
  "visibleColumnIds" | "visibleMetricKeys"
> & {
  readonly visibleColumnIds: ReadonlySet<string>;
  readonly visibleMetricKeys: ReadonlySet<string>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXTURE_NOW_MS = Date.parse("2026-08-20T00:00:00.000Z");

export const SESSION_SORT_CONFIGS = Object.fromEntries(
  SESSION_SORT_FIELDS.map((field) => [field.id, sortConfigForField(field)])
) as Record<SessionSortFieldId, SortConfig<SessionRow>>;

export function sortDemoRows(
  rows: SessionRow[],
  sortBy: string | null,
  sortDir: SortDirection
): SessionRow[] {
  return sortTableData(rows, sortBy, SESSION_SORT_CONFIGS, sortDir);
}

export function isWithinDateRange(row: SessionRow, dateRange: string): boolean {
  const definition = SESSION_DATE_RANGE_DEFINITIONS.find(
    (candidate) => candidate.value === dateRange
  );
  if (!definition) {
    return false;
  }
  if (definition.days === null) {
    return true;
  }
  return Date.parse(row.updatedAt) >= FIXTURE_NOW_MS - definition.days * DAY_MS;
}

export function metricValue(
  metricKey: string,
  rows: readonly SessionRow[]
): string {
  if (metricKey === "spend") {
    const total = rows.reduce((sum, row) => sum + row.cost, 0);
    return `$${total.toFixed(2)}`;
  }
  if (metricKey === "active") {
    return String(
      rows.filter((row) => row.status === SESSION_STATUS.ACTIVE).length
    );
  }
  if (metricKey === "failures") {
    return String(
      rows.filter((row) => row.status === SESSION_STATUS.ERROR).length
    );
  }
  return String(rows.length);
}

/** Build the two-level group tree the production table consumes. */
export function buildDemoGroups(
  rows: readonly SessionRow[],
  grouping: TableGroupingState
): GridTableV2Group<SessionRow>[] {
  const primaryField = grouping.primary.fieldId;
  if (primaryField === null) {
    return [];
  }
  const secondaryField = grouping.secondary.fieldId;
  return partition(rows, primaryField, grouping.primary.order).map(
    ([key, items]) => ({
      key,
      label: groupLabel(primaryField, key),
      items,
      subgroups:
        secondaryField === null
          ? undefined
          : partition(items, secondaryField, grouping.secondary.order).map(
              ([subKey, subItems]) => ({
                key: subKey,
                label: groupLabel(secondaryField, subKey),
                items: subItems,
              })
            ),
    })
  );
}

export function toggleValue(
  values: readonly string[],
  value: string
): string[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

export function toggleSetMember(
  current: ReadonlySet<string>,
  key: string
): Set<string> {
  const next = new Set(current);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

export function buildFilterController({
  onClearAll,
  setOwners,
  setStatuses,
  statuses,
}: {
  onClearAll: () => void;
  setOwners: (next: string[]) => void;
  setStatuses: (next: string[]) => void;
  statuses: readonly string[];
}): TableFiltersController {
  return {
    filters: {
      assigneeIds: [],
      assignToMe: false,
      hideCompletedItems: false,
      favoritesOnly: false,
      statuses: [...statuses],
      priorities: [],
      date: null,
      tagIds: [],
    },
    toggleAssignee: () => undefined,
    toggleAssignToMe: () => undefined,
    toggleHideCompletedItems: () => undefined,
    toggleFavoritesOnly: () => undefined,
    toggleStatus: (status) => setStatuses(toggleValue(statuses, status)),
    togglePriority: () => undefined,
    setDateFilter: () => undefined,
    toggleTag: () => undefined,
    clearCategoryFilter: (category) => {
      if (category === "status") {
        setStatuses([]);
      }
      if (category === "assignee") {
        setOwners([]);
      }
    },
    clearAllFilters: onClearAll,
    activeChips: [],
  };
}

export function captureViewState(input: DemoViewStateInput): DemoViewState {
  return {
    dateRange: input.dateRange,
    grouping: cloneGrouping(input.grouping),
    owners: [...input.owners],
    sortBy: input.sortBy,
    sortDir: input.sortDir,
    statuses: [...input.statuses],
    visibleColumnIds: [...input.visibleColumnIds],
    visibleMetricKeys: [...input.visibleMetricKeys],
  };
}

export function initialSavedViewStates(): Readonly<
  Record<string, DemoViewState>
> {
  const initial: Record<string, DemoViewState> = Object.create(null);
  for (const view of SESSION_SAVED_VIEWS) {
    initial[view.id] = {
      dateRange: "30d",
      grouping: cloneGrouping(EMPTY_TABLE_GROUPING),
      owners: [],
      sortBy: null,
      sortDir: "asc",
      statuses: [],
      visibleColumnIds: [...DEFAULT_VISIBLE_COLUMN_IDS],
      visibleMetricKeys: [...DEFAULT_VISIBLE_METRIC_KEYS],
    };
  }
  return initial;
}

function compareSessionIds(left: SessionRow, right: SessionRow): number {
  return left.id.localeCompare(right.id);
}

function sortConfigForField(
  field: (typeof SESSION_SORT_FIELDS)[number]
): SortConfig<SessionRow> {
  if (field.kind === SessionSortKind.Status) {
    return {
      comparator: (left, right) =>
        SESSION_STATUS_RANK[left.status] - SESSION_STATUS_RANK[right.status],
      key: field.key,
      tieBreak: compareSessionIds,
    };
  }
  if (field.kind === SessionSortKind.Number) {
    return {
      columnType: "number",
      key: field.key,
      tieBreak: compareSessionIds,
    };
  }
  if (field.kind === SessionSortKind.Date) {
    return {
      columnType: "date",
      key: field.key,
      tieBreak: compareSessionIds,
    };
  }
  if (field.kind === SessionSortKind.String) {
    return { key: field.key, tieBreak: compareSessionIds };
  }
  return assertNever(field);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled session sort field: ${String(value)}`);
}

function partition(
  rows: readonly SessionRow[],
  field: string,
  order: TableGroupOrder
): [string, SessionRow[]][] {
  const buckets = new Map<string, SessionRow[]>();
  for (const row of rows) {
    const key = String(row[field as keyof SessionRow] ?? "—");
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      buckets.set(key, [row]);
    }
  }
  const entries = [...buckets.entries()];
  if (order === TableGroupOrder.Custom) {
    return entries;
  }
  const sign = order === TableGroupOrder.Ascending ? 1 : -1;
  return entries.sort(([left], [right]) => left.localeCompare(right) * sign);
}

function cloneGrouping(grouping: TableGroupingState): TableGroupingState {
  return {
    primary: { ...grouping.primary },
    secondary: { ...grouping.secondary },
  };
}

function groupLabel(field: string, value: string): string {
  if (field !== "status") {
    return value;
  }
  const status = Object.values(SESSION_STATUS).find(
    (candidate) => candidate === value
  );
  return status ? SESSION_STATUS_LABELS[status] : value;
}
