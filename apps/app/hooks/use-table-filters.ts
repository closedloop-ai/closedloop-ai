"use client";

import type { Priority } from "@repo/api/src/types/common";
import { DocumentStatus } from "@repo/api/src/types/document";
import { useCallback, useMemo, useState } from "react";
import type { DocumentRowItem } from "@/components/document-table/document-row";

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
  statuses: string[];
  priorities: Priority[];
  date: DateFilter | null;
};

export const FilterPanelView = {
  Categories: "categories",
  Assignee: "assignee",
  Status: "status",
  Priority: "priority",
  Dates: "dates",
  DatesCreated: "dates_created",
  DatesUpdated: "dates_updated",
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

// ---- Helper: get visible statuses ----

export function getStatusesForCategory(): DocumentStatus[] {
  return Object.values(DocumentStatus);
}

// ---- Initial state ----

const INITIAL_FILTERS: TableFilters = {
  assigneeIds: [],
  assignToMe: false,
  statuses: [],
  priorities: [],
  date: null,
};

// ---- Hook ----

type UseTableFiltersOptions = {
  items: DocumentRowItem[];
  currentUserId?: string;
};

export function useTableFilters({
  items,
  currentUserId,
}: UseTableFiltersOptions) {
  const [filters, setFilters] = useState<TableFilters>(INITIAL_FILTERS);

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
    [currentUserId]
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
    [currentUserId]
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
  }, [currentUserId]);

  const toggleStatus = useCallback((status: string) => {
    setFilters((prev) => {
      const next = prev.statuses.includes(status)
        ? prev.statuses.filter((s) => s !== status)
        : [...prev.statuses, status];
      return { ...prev, statuses: next };
    });
  }, []);

  const togglePriority = useCallback((priority: Priority) => {
    setFilters((prev) => {
      const next = prev.priorities.includes(priority)
        ? prev.priorities.filter((p) => p !== priority)
        : [...prev.priorities, priority];
      return { ...prev, priorities: next };
    });
  }, []);

  const setDateFilter = useCallback((date: DateFilter | null) => {
    setFilters((prev) => ({ ...prev, date }));
  }, []);

  const clearCategoryFilter = useCallback(
    (category: "assignee" | "status" | "priority" | "date") => {
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
          default:
            return prev;
        }
      });
    },
    []
  );

  const clearAllFilters = useCallback(() => {
    setFilters(INITIAL_FILTERS);
  }, []);

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
      counts.set(priority, (counts.get(priority) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  // ---- Active filter accounting ----

  const activeFilterCount = useMemo(() => {
    let count = 0;
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

  const applyFilters = useCallback(
    (targetItems: DocumentRowItem[]): DocumentRowItem[] => {
      if (!isAnyFilterActive) {
        return targetItems;
      }

      return targetItems.filter((item) => {
        if (!matchesAssigneeFilter(item, filters.assigneeIds)) {
          return false;
        }
        if (
          filters.statuses.length > 0 &&
          !filters.statuses.includes(item.data.status)
        ) {
          return false;
        }
        if (
          filters.priorities.length > 0 &&
          !filters.priorities.includes(item.data.priority)
        ) {
          return false;
        }
        if (
          filters.date &&
          !matchesDateFilter(item, filters.date, isCustomRangeValid)
        ) {
          return false;
        }
        return true;
      });
    },
    [filters, isAnyFilterActive, isCustomRangeValid]
  );

  // ---- Chip labels ----

  const activeChips = useMemo(() => {
    const chips: {
      category: "assignee" | "status" | "priority" | "date";
      label: string;
    }[] = [];
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
    return chips;
  }, [filters]);

  return {
    filters,
    setAssignees,
    toggleAssignee,
    toggleAssignToMe,
    toggleStatus,
    togglePriority,
    setDateFilter,
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
  };
}

export type TableFiltersReturn = ReturnType<typeof useTableFilters>;
