"use client";

import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus } from "@repo/api/src/types/document";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import {
  isDocumentRowItem,
  isRowItemCompleted,
} from "@repo/app/documents/components/table/row-type-registry";
import {
  reviveDates,
  useViewStatePersistence,
} from "@repo/app/shared/hooks/use-view-state-persistence";
import { useCallback, useMemo } from "react";

// ---- Const objects & types ----

export const DatePreset = {
  Last24h: "LAST_24H",
  Last7d: "LAST_7D",
  Last30d: "LAST_30D",
  Last3m: "LAST_3M",
  Custom: "CUSTOM",
} as const;
export type DatePreset = (typeof DatePreset)[keyof typeof DatePreset];

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  [DatePreset.Last24h]: "Last 24 hours",
  [DatePreset.Last7d]: "Last 7 days",
  [DatePreset.Last30d]: "Last 30 days",
  [DatePreset.Last3m]: "Last 3 months",
  [DatePreset.Custom]: "Custom range",
};

export const DateFilterField = {
  CreatedAt: "CREATED_AT",
  UpdatedAt: "UPDATED_AT",
} as const;
export type DateFilterField =
  (typeof DateFilterField)[keyof typeof DateFilterField];

export type DateFilter = {
  field: DateFilterField;
  preset: DatePreset;
  startDate?: Date;
  endDate?: Date;
};

export type TableFilters = {
  assigneeIds: string[];
  assignToMe: boolean;
  hideCompletedItems: boolean;
  favoritesOnly: boolean;
  statuses: DocumentStatus[];
  priorities: Priority[];
  date: DateFilter | null;
  tagIds: string[];
};

export const FilterPanelView = {
  Categories: "categories",
  Assignee: "assignee",
  Status: "status",
  Priority: "priority",
  Dates: "dates",
  DatesCreated: "dates_created",
  DatesUpdated: "dates_updated",
  Tags: "tags",
} as const;
export type FilterPanelView =
  (typeof FilterPanelView)[keyof typeof FilterPanelView];

// ---- Date preset computation ----

function getDateRangeForPreset(
  preset: DatePreset
): { start: Date; end: Date } | null {
  if (preset === DatePreset.Custom) {
    return null;
  }
  const now = new Date();
  const start = new Date(now);
  switch (preset) {
    case DatePreset.Last24h:
      start.setHours(start.getHours() - 24);
      break;
    case DatePreset.Last7d:
      start.setDate(start.getDate() - 7);
      break;
    case DatePreset.Last30d:
      start.setDate(start.getDate() - 30);
      break;
    case DatePreset.Last3m:
      start.setMonth(start.getMonth() - 3);
      break;
    default:
      break;
  }
  return { start, end: now };
}

// ---- Filter predicates ----

function matchesAssigneeFilter(
  item: DocumentRowItem,
  assigneeIds: string[]
): boolean {
  if (assigneeIds.length === 0) {
    return true;
  }
  const assigneeId = item.data.assigneeId;
  return assigneeIds.some((id) =>
    id === "__unassigned__" ? !assigneeId : id === assigneeId
  );
}

function matchesTagFilter(item: DocumentRowItem, tagIds: string[]): boolean {
  if (tagIds.length === 0) {
    return true;
  }
  const itemTags: Array<{ id: string }> =
    "tags" in item.data ? (item.data.tags ?? []) : [];
  return itemTags.some((t) => tagIds.includes(t.id));
}

function matchesDateFilter(
  item: DocumentRowItem,
  dateFilter: DateFilter,
  isCustomRangeValid: boolean
): boolean {
  let range: { start: Date; end: Date } | null = null;
  if (dateFilter.preset === DatePreset.Custom) {
    if (dateFilter.startDate && dateFilter.endDate && isCustomRangeValid) {
      range = { start: dateFilter.startDate, end: dateFilter.endDate };
    }
  } else {
    range = getDateRangeForPreset(dateFilter.preset);
  }
  if (!range) {
    return true;
  }
  const field =
    dateFilter.field === DateFilterField.CreatedAt
      ? item.data.createdAt
      : item.data.updatedAt;
  const fieldDate = new Date(field);
  return fieldDate >= range.start && fieldDate <= range.end;
}

/**
 * Status, priority, and tag filters describe document fields — apply them to
 * document rows only (see `applyFilters` for the non-document bypass).
 */
function matchesDocumentOnlyFilters(
  item: Extract<DocumentRowItem, { kind: "document" }>,
  filters: TableFilters
): boolean {
  if (
    filters.statuses.length > 0 &&
    !filters.statuses.includes(item.data.status)
  ) {
    return false;
  }
  if (
    filters.priorities.length > 0 &&
    !(item.data.priority && filters.priorities.includes(item.data.priority))
  ) {
    return false;
  }
  return matchesTagFilter(item, filters.tagIds);
}

// ---- Initial state ----

const INITIAL_FILTERS: TableFilters = {
  assigneeIds: [],
  assignToMe: false,
  hideCompletedItems: false,
  favoritesOnly: false,
  statuses: [],
  priorities: [],
  date: null,
  tagIds: [],
};

const PERSISTENCE_DEFAULT: TableFilters = {
  ...INITIAL_FILTERS,
  hideCompletedItems: true,
};

// ---- Filter validation (strips invalid enum values on restore) ----

const VALID_STATUSES = new Set<string>(Object.values(DocumentStatus));
const VALID_PRIORITIES = new Set<string>(Object.values(Priority));
const VALID_DATE_FIELDS = new Set<string>(Object.values(DateFilterField));
const VALID_DATE_PRESETS = new Set<string>(Object.values(DatePreset));

function validateFilters(filters: TableFilters): TableFilters {
  let date = filters.date;
  if (date) {
    if (
      VALID_DATE_FIELDS.has(date.field) &&
      VALID_DATE_PRESETS.has(date.preset)
    ) {
      date = reviveDates(date, ["startDate", "endDate"]);
    } else {
      date = null;
    }
  }

  return {
    ...filters,
    statuses: filters.statuses.filter((s) => VALID_STATUSES.has(s)),
    priorities: filters.priorities.filter((p) => VALID_PRIORITIES.has(p)),
    date,
  };
}

// ---- Hook ----

type UseTableFiltersOptions = {
  items: DocumentRowItem[];
  currentUserId?: string;
  persistenceKey?: string;
  favoriteArtifactIds?: string[];
};

export function useTableFilters({
  items,
  currentUserId,
  persistenceKey,
  favoriteArtifactIds,
}: UseTableFiltersOptions) {
  const [filters, setFilters, clearPersistedFilters] =
    useViewStatePersistence<TableFilters>(
      persistenceKey ?? null,
      PERSISTENCE_DEFAULT,
      {
        validate: validateFilters,
      }
    );

  // ---- Mutators ----

  const setAssignees = useCallback(
    (ids: string[]) => {
      setFilters((prev) => ({
        ...prev,
        assigneeIds: ids,
        assignToMe:
          prev.assignToMe &&
          currentUserId != null &&
          ids.includes(currentUserId),
      }));
    },
    [currentUserId, setFilters]
  );

  const toggleAssignee = useCallback(
    (id: string) => {
      setFilters((prev) => {
        const isRemoving = prev.assigneeIds.includes(id);
        const next = isRemoving
          ? prev.assigneeIds.filter((a) => a !== id)
          : [...prev.assigneeIds, id];
        return {
          ...prev,
          assigneeIds: next,
          assignToMe:
            prev.assignToMe &&
            currentUserId != null &&
            next.includes(currentUserId),
        };
      });
    },
    [currentUserId, setFilters]
  );

  const toggleAssignToMe = useCallback(() => {
    if (!currentUserId) {
      return;
    }
    setFilters((prev) => {
      const wasOn = prev.assignToMe;
      if (wasOn) {
        return {
          ...prev,
          assignToMe: false,
          assigneeIds: prev.assigneeIds.filter((id) => id !== currentUserId),
        };
      }
      const nextIds = prev.assigneeIds.includes(currentUserId)
        ? prev.assigneeIds
        : [...prev.assigneeIds, currentUserId];
      return { ...prev, assignToMe: true, assigneeIds: nextIds };
    });
  }, [currentUserId, setFilters]);

  const toggleStatus = useCallback(
    (status: DocumentStatus) => {
      setFilters((prev) => {
        const next = prev.statuses.includes(status)
          ? prev.statuses.filter((s) => s !== status)
          : [...prev.statuses, status];
        return { ...prev, statuses: next };
      });
    },
    [setFilters]
  );

  const togglePriority = useCallback(
    (priority: Priority) => {
      setFilters((prev) => {
        const next = prev.priorities.includes(priority)
          ? prev.priorities.filter((p) => p !== priority)
          : [...prev.priorities, priority];
        return { ...prev, priorities: next };
      });
    },
    [setFilters]
  );

  const setDateFilter = useCallback(
    (date: DateFilter | null) => {
      setFilters((prev) => ({ ...prev, date }));
    },
    [setFilters]
  );

  const toggleTag = useCallback(
    (tagId: string) => {
      setFilters((prev) => {
        const next = prev.tagIds.includes(tagId)
          ? prev.tagIds.filter((t) => t !== tagId)
          : [...prev.tagIds, tagId];
        return { ...prev, tagIds: next };
      });
    },
    [setFilters]
  );

  const clearCategoryFilter = useCallback(
    (
      category:
        | "assignee"
        | "status"
        | "priority"
        | "date"
        | "hideCompleted"
        | "favorites"
        | "tags"
    ) => {
      setFilters((prev) => {
        switch (category) {
          case "assignee":
            return { ...prev, assigneeIds: [], assignToMe: false };
          case "status":
            return { ...prev, statuses: [] };
          case "priority":
            return { ...prev, priorities: [] };
          case "date":
            return { ...prev, date: null };
          case "hideCompleted":
            return { ...prev, hideCompletedItems: false };
          case "favorites":
            return { ...prev, favoritesOnly: false };
          case "tags":
            return { ...prev, tagIds: [] };
          default:
            return prev;
        }
      });
    },
    [setFilters]
  );

  const toggleHideCompletedItems = useCallback(() => {
    setFilters((prev) => ({
      ...prev,
      hideCompletedItems: !prev.hideCompletedItems,
    }));
  }, [setFilters]);

  const toggleFavoritesOnly = useCallback(() => {
    setFilters((prev) => ({
      ...prev,
      favoritesOnly: !prev.favoritesOnly,
    }));
  }, [setFilters]);

  const clearAllFilters = useCallback(() => {
    setFilters(INITIAL_FILTERS);
  }, [setFilters]);

  // ---- Derived counts ----

  const assigneeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let unassigned = 0;
    for (const item of items) {
      const assigneeId = item.data.assigneeId;
      if (assigneeId) {
        counts.set(assigneeId, (counts.get(assigneeId) ?? 0) + 1);
      } else {
        unassigned++;
      }
    }
    counts.set("__unassigned__", unassigned);
    return counts;
  }, [items]);

  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const status = item.data.status;
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  const priorityCounts = useMemo(() => {
    const counts = new Map<Priority, number>();
    for (const item of items) {
      const priority = item.data.priority;
      if (!priority) {
        continue;
      }
      counts.set(priority, (counts.get(priority) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  // ---- Active filter accounting ----

  const hasCategoryFilters = useMemo(() => {
    return (
      filters.assigneeIds.length > 0 ||
      filters.statuses.length > 0 ||
      filters.priorities.length > 0 ||
      filters.date !== null ||
      filters.tagIds.length > 0
    );
  }, [
    filters.assigneeIds,
    filters.statuses,
    filters.priorities,
    filters.date,
    filters.tagIds,
  ]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.hideCompletedItems) {
      count++;
    }
    if (filters.favoritesOnly) {
      count++;
    }
    if (filters.assigneeIds.length > 0) {
      count++;
    }
    if (filters.statuses.length > 0) {
      count++;
    }
    if (filters.priorities.length > 0) {
      count++;
    }
    if (filters.date) {
      count++;
    }
    if (filters.tagIds.length > 0) {
      count++;
    }
    return count;
  }, [filters]);

  const isAnyFilterActive = activeFilterCount > 0;

  // ---- Custom date range validity ----

  const isCustomRangeValid = useMemo(() => {
    if (!filters.date || filters.date.preset !== DatePreset.Custom) {
      return true;
    }
    if (!(filters.date.startDate && filters.date.endDate)) {
      return false;
    }
    return filters.date.endDate >= filters.date.startDate;
  }, [filters.date]);

  // ---- Apply filters ----

  const favoriteIdSet = useMemo(
    () => new Set(favoriteArtifactIds ?? []),
    [favoriteArtifactIds]
  );

  const applyFilters = useCallback(
    (targetItems: DocumentRowItem[]): DocumentRowItem[] => {
      // Completion is decided per row kind by the registry (DocumentStatus,
      // GitHubPRState, or terminal harness strings for sessions).
      let visibleItems = filters.hideCompletedItems
        ? targetItems.filter((item) => !isRowItemCompleted(item))
        : targetItems;

      if (filters.favoritesOnly) {
        visibleItems = visibleItems.filter(
          (item) => item.kind === "project" || favoriteIdSet.has(item.data.id)
        );
      }

      if (!hasCategoryFilters) {
        return visibleItems;
      }

      return visibleItems.filter((item) => {
        if (!matchesAssigneeFilter(item, filters.assigneeIds)) {
          return false;
        }
        if (
          filters.date &&
          !matchesDateFilter(item, filters.date, isCustomRangeValid)
        ) {
          return false;
        }
        // Status, priority, and tag filters describe document fields. Branch
        // rows carry GitHubPRState statuses, session rows carry free-form
        // harness strings, and neither has a user-set priority or tags — so
        // these clauses must not exclude non-document rows (a status filter
        // persisted from the Documents tab would otherwise blank the
        // Branches tab entirely).
        if (!isDocumentRowItem(item)) {
          return true;
        }
        return matchesDocumentOnlyFilters(item, filters);
      });
    },
    [filters, hasCategoryFilters, isCustomRangeValid, favoriteIdSet]
  );

  // ---- Chip labels ----

  const activeChips = useMemo(() => {
    const chips: {
      category:
        | "assignee"
        | "status"
        | "priority"
        | "date"
        | "hideCompleted"
        | "favorites"
        | "tags";
      label: string;
    }[] = [];
    if (filters.hideCompletedItems) {
      chips.push({
        category: "hideCompleted",
        label: "Hide completed items",
      });
    }
    if (filters.favoritesOnly) {
      chips.push({ category: "favorites", label: "My Favorites" });
    }
    if (filters.assigneeIds.length > 0) {
      chips.push({
        category: "assignee",
        label: `Assignee: ${filters.assigneeIds.length}`,
      });
    }
    if (filters.statuses.length > 0) {
      chips.push({
        category: "status",
        label: `Status: ${filters.statuses.length}`,
      });
    }
    if (filters.priorities.length > 0) {
      chips.push({
        category: "priority",
        label: `Priority: ${filters.priorities.length}`,
      });
    }
    if (filters.date) {
      const fieldLabel =
        filters.date.field === DateFilterField.CreatedAt
          ? "Created"
          : "Updated";
      chips.push({
        category: "date",
        label: `${fieldLabel}: ${DATE_PRESET_LABELS[filters.date.preset]}`,
      });
    }
    if (filters.tagIds.length > 0) {
      chips.push({
        category: "tags",
        label: `Tags: ${filters.tagIds.length}`,
      });
    }
    return chips;
  }, [filters]);

  return {
    filters,
    setAssignees,
    toggleAssignee,
    toggleAssignToMe,
    toggleHideCompletedItems,
    toggleFavoritesOnly,
    toggleStatus,
    togglePriority,
    setDateFilter,
    toggleTag,
    clearCategoryFilter,
    clearAllFilters,
    activeFilterCount,
    isAnyFilterActive,
    isCustomRangeValid,
    applyFilters,
    activeChips,
    assigneeCounts,
    statusCounts,
    priorityCounts,
    clearPersistedFilters,
  };
}

export type TableFiltersReturn = ReturnType<typeof useTableFilters>;
