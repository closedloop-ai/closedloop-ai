"use client";

import { ArtifactDateField } from "@repo/api/src/types/artifact-date-filter";
import { DISPLAYED_ARTIFACT_STATUS } from "@repo/api/src/types/artifact-status";
import { Priority } from "@repo/api/src/types/common";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import type { PriorityFacetValue } from "@repo/app/documents/components/table/document-table-filters";
import {
  isDocumentRowItem,
  isRowItemCompleted,
} from "@repo/app/documents/components/table/row-type-registry";
import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import { documentRowStatusEvidence } from "@repo/app/documents/lib/artifact-row-adapter";
import {
  type ArtifactStatusFacetValue,
  artifactStatusFacetValue,
  isArtifactStatusFacetValue,
} from "@repo/app/documents/lib/artifact-status-facet-value";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  reviveDates,
  useViewStatePersistence,
} from "@repo/app/shared/hooks/use-view-state-persistence";
import { useCallback, useMemo } from "react";
import { z } from "zod";

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

/**
 * Aliases the shared vocabulary. The values moved to
 * `@repo/api/src/types/artifact-date-filter` when ISS-10471 gave the date
 * filter a second consumer — the assigned-tree query, which cannot import this
 * package — and the alias keeps every existing `DateFilterField` reference
 * working against the one declaration.
 */
export const DateFilterField = ArtifactDateField;
export type DateFilterField = ArtifactDateField;

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
  statuses: ArtifactStatusFacetValue[];
  priorities: PriorityFacetValue[];
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

/**
 * A preset's absolute bounds against a GIVEN clock.
 *
 * Exported with `now` injected so a caller that must not re-read the clock can
 * share this one definition (ISS-10472). The server-paged My Tasks board is
 * that caller: it resolves the window once per selection and sends it on the
 * wire, while the predicate below re-resolves per render — two clocks, but one
 * set of preset arithmetic, so a change to what "Last 7 days" means cannot
 * make the two disagree about which rows it selects.
 *
 * This keeps `artifact-date-filter.ts`'s claim true, that a preset becomes a
 * range in exactly one place.
 */
export function dateRangeForPreset(
  preset: DatePreset,
  now: Date
): { start: Date; end: Date } | null {
  if (preset === DatePreset.Custom) {
    return null;
  }
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
    default: {
      // Exhaustive over the non-custom presets: a new one must define its own
      // window here rather than falling through to a zero-width start===end
      // range that filters every row out.
      const exhaustive: never = preset;
      return exhaustive;
    }
  }
  return { start, end: now };
}

/** The live-clock form the browser predicate uses. */
function getDateRangeForPreset(
  preset: DatePreset
): { start: Date; end: Date } | null {
  return dateRangeForPreset(preset, new Date());
}

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
  filters: TableFilters,
  statusEvidence: (item: DocumentRowItem) => ArtifactStatusFacetValue | null
): boolean {
  const status = statusEvidence(item);
  if (
    filters.statuses.length > 0 &&
    (status === null || !filters.statuses.includes(status))
  ) {
    return false;
  }
  // ISS-9665: an unset priority is matched EXPLICITLY, against its own facet
  // value, instead of falling out of every priority filter by being falsy. A
  // NULL silently excluded from a filter is the same defect class as a NULL
  // silently serialized as MEDIUM.
  if (
    filters.priorities.length > 0 &&
    !filters.priorities.includes(item.data.priority ?? PRIORITY_UNSET_VALUE)
  ) {
    return false;
  }
  return matchesTagFilter(item, filters.tagIds);
}

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

// Restore-boundary validation: invalid enum values are stripped, not rejected.
// Mixed table renders Documents and Features; accept either vocabulary plus the
// one render-only Unknown sentinel (PRD-495 / ISS-10816).
const VALID_PRIORITIES = new Set<string>([
  ...Object.values(Priority),
  PRIORITY_UNSET_VALUE,
]);
const VALID_DATE_FIELDS = new Set<string>(Object.values(DateFilterField));
const VALID_DATE_PRESETS = new Set<string>(Object.values(DatePreset));

function validateFilters(filters: unknown): TableFilters {
  const parsedFilters = tableFiltersPersistenceSchema.parse(filters);
  let date: DateFilter | null = null;
  if (
    parsedFilters.date &&
    VALID_DATE_FIELDS.has(parsedFilters.date.field) &&
    VALID_DATE_PRESETS.has(parsedFilters.date.preset)
  ) {
    date = reviveDates(parsedFilters.date, [
      "startDate",
      "endDate",
    ]) as DateFilter;
  }

  return {
    ...parsedFilters,
    statuses: parsedFilters.statuses.filter(
      (status): status is ArtifactStatusFacetValue =>
        isArtifactStatusFacetValue(status)
    ),
    priorities: parsedFilters.priorities.filter(
      (priority): priority is PriorityFacetValue =>
        typeof priority === "string" && VALID_PRIORITIES.has(priority)
    ),
    date,
  };
}

type UseTableFiltersOptions = {
  items: DocumentRowItem[];
  currentUserId?: string;
  /**
   * ISS-9726: `null` (the active organization has not resolved) takes the same
   * memory-only branch an omitted key does — the persisted payload carries
   * assignee and tag UUIDs, so there is no organization it could honestly be
   * attributed to yet.
   */
  persistenceKey?: string | null;
  favoriteArtifactIds?: string[];
  /**
   * Whether this surface can express the `Unknown` status facet at all
   * (ISS-10472, operator ruling 2026-10-21). Defaults to true.
   *
   * `Unknown` is the browser's bucket for a row whose stored status is off both
   * vocabularies, so it only exists as a client-side predicate. A surface that
   * filters SERVER-side cannot send it — the route's status enum is the stored
   * inventory — so the My Tasks All tab passes false and the facet is neither
   * offered nor applied there.
   */
  supportsUnknownStatusFacet?: boolean;
};

export function useTableFilters({
  items,
  currentUserId,
  persistenceKey,
  favoriteArtifactIds,
  supportsUnknownStatusFacet = true,
}: UseTableFiltersOptions) {
  const [persistedFilters, setFilters, clearPersistedFilters] =
    useViewStatePersistence<TableFilters>(
      persistenceKey ?? null,
      PERSISTENCE_DEFAULT,
      {
        validate: validateFilters,
      }
    );

  // ISS-9665: the selection is persisted to localStorage for 7 days, but the
  // flag can go off inside that window (rollback, cohort change, an
  // unreachable provider). A restored "No priority" selection would then filter
  // rows whose null priority the flag-off path has already folded back to
  // MEDIUM, matching nothing — an empty table with no visible chip to clear,
  // because the facet option that put it there is not rendered either. So it is
  // dropped from the ACTIVE filters while the flag is off, and left untouched
  // in storage so turning the flag back on restores what the user chose.
  const unsetPriorityEnabled = useFeatureFlagEnabledOptional(
    ARTIFACT_PRIORITY_UNSET_FLAG_KEY
  );
  const universalStatusEnabled = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  const statusEvidence = universalStatusEnabled
    ? projectedDocumentStatusEvidence
    : storedStatusEvidence;
  // Both have to hold: the flag decides whether the vocabulary exists, the
  // surface decides whether it can express it.
  const canSelectUnknownStatus =
    universalStatusEnabled && supportsUnknownStatusFacet;
  const filters = useMemo<TableFilters>(() => {
    const priorities =
      unsetPriorityEnabled ||
      !persistedFilters.priorities.includes(PRIORITY_UNSET_VALUE)
        ? persistedFilters.priorities
        : persistedFilters.priorities.filter(
            (priority) => priority !== PRIORITY_UNSET_VALUE
          );
    // Dropped from the ACTIVE filters for the same reason the priority strip
    // above drops its token, and left untouched in storage: a selection this
    // surface cannot apply would otherwise narrow the board with no chip to
    // clear it, because the facet option that put it there is not rendered
    // here either.
    const statuses = canSelectUnknownStatus
      ? persistedFilters.statuses
      : persistedFilters.statuses.filter(
          (status) => status !== DISPLAYED_ARTIFACT_STATUS.Unknown
        );
    if (
      priorities === persistedFilters.priorities &&
      statuses === persistedFilters.statuses
    ) {
      return persistedFilters;
    }
    return {
      ...persistedFilters,
      priorities,
      statuses,
    };
  }, [persistedFilters, canSelectUnknownStatus, unsetPriorityEnabled]);

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
    (status: ArtifactStatusFacetValue) => {
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
    (priority: PriorityFacetValue) => {
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
    const counts = new Map<ArtifactStatusFacetValue, number>();
    for (const item of items) {
      const status = statusEvidence(item);
      if (status === null) {
        continue;
      }
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return counts;
  }, [items, statusEvidence]);

  const priorityCounts = useMemo(() => {
    const counts = new Map<PriorityFacetValue, number>();
    for (const item of items) {
      // ISS-9444: counted over the SAME population the priority filter decides.
      // `items` is typed `DocumentRowItem[]` and `applyFilters` passes every
      // non-document row straight through, so a branch or session reaching here
      // was counted under a dimension it cannot be narrowed by — and since its
      // `priority` is absent, under the UNSET value specifically, which per the
      // artifacts-only ownership ruling (2026-09-11) states that a branch has a
      // priority and it is unset. LATENT, not shipped: both production callers
      // reach this through `useProjectFilters`, whose items are
      // `DocumentRowData[]` mapped to document rows, so no rendered count
      // changes. The guard is here because the signature admits the case and
      // the count and the filter must not disagree by construction.
      if (!isDocumentRowItem(item)) {
        continue;
      }
      // ISS-9665: unset rows are counted under their own facet value rather
      // than dropped, so the "No priority" option can state how many rows it
      // would keep — the same promise every other option in this menu makes.
      const priority = item.data.priority ?? PRIORITY_UNSET_VALUE;
      counts.set(priority, (counts.get(priority) ?? 0) + 1);
    }
    return counts;
  }, [items]);

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

  const isCustomRangeValid = useMemo(() => {
    if (!filters.date || filters.date.preset !== DatePreset.Custom) {
      return true;
    }
    if (!(filters.date.startDate && filters.date.endDate)) {
      return false;
    }
    return filters.date.endDate >= filters.date.startDate;
  }, [filters.date]);

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
        return matchesDocumentOnlyFilters(item, filters, statusEvidence);
      });
    },
    [
      filters,
      hasCategoryFilters,
      isCustomRangeValid,
      favoriteIdSet,
      statusEvidence,
    ]
  );

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
    /**
     * Whether the `Unknown` status option may be OFFERED. Read from here rather
     * than re-derived at the facet UI, so the set of values that can be
     * selected and the set that are applied cannot disagree — a dead option
     * the user can click with no effect is the failure this prevents.
     */
    canSelectUnknownStatus,
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

function storedStatusEvidence(
  item: DocumentRowItem
): ArtifactStatusFacetValue | null {
  return item.kind === "document" ? item.data.status : null;
}

function projectedDocumentStatusEvidence(
  item: DocumentRowItem
): ArtifactStatusFacetValue | null {
  return item.kind === "document"
    ? artifactStatusFacetValue(
        item.data.type,
        documentRowStatusEvidence(item.data)
      )
    : null;
}

const persistedDateFilterSchema = z
  .object({
    field: z.string(),
    preset: z.string(),
    startDate: z.union([z.iso.datetime(), z.date()]).optional(),
    endDate: z.union([z.iso.datetime(), z.date()]).optional(),
  })
  .nullable()
  .catch(null);

const tableFiltersPersistenceShape = {
  assigneeIds: z.array(z.string()).catch(PERSISTENCE_DEFAULT.assigneeIds),
  assignToMe: z.boolean().catch(PERSISTENCE_DEFAULT.assignToMe),
  hideCompletedItems: z.boolean().catch(PERSISTENCE_DEFAULT.hideCompletedItems),
  favoritesOnly: z.boolean().catch(PERSISTENCE_DEFAULT.favoritesOnly),
  statuses: z.array(z.unknown()).catch(PERSISTENCE_DEFAULT.statuses),
  priorities: z.array(z.unknown()).catch(PERSISTENCE_DEFAULT.priorities),
  date: persistedDateFilterSchema,
  tagIds: z.array(z.string()).catch(PERSISTENCE_DEFAULT.tagIds),
} satisfies Record<keyof TableFilters, z.ZodTypeAny>;

const tableFiltersPersistenceSchema = z
  .object(tableFiltersPersistenceShape)
  .catch(PERSISTENCE_DEFAULT);
