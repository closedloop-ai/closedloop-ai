"use client";

import type { Priority } from "@repo/api/src/types/common";
import type {
  ProjectStatus,
  ProjectWithDetails,
} from "@repo/api/src/types/project";
import { PROJECT_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import { useFilterCurrentUser } from "@repo/app/shared/hooks/use-filter-current-user";
import { useReplaceListParams } from "@repo/app/shared/hooks/use-replace-list-params";
import { initialFacetParamsSource } from "@repo/app/shared/lib/facet-filter-params";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import {
  useCurrentUser,
  useOrganizationUsers,
} from "@repo/app/users/hooks/use-users";
import {
  TABLE_DATE_PRESET_LABELS,
  TableDateFilterField,
  type TableFilterCategory,
  type TableFilterChip,
  type TableFiltersController,
  type TableFiltersState,
  type TableFiltersViewModel,
} from "@repo/design-system/components/ui/table-filters";
import { PRIORITY_LABELS } from "@repo/design-system/lib/priority-order";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  EMPTY_PROJECT_FILTERS,
  parseProjectFilterParams,
  writeProjectFilterParams,
} from "./project-filter-params";

/**
 * The team Projects list's filter state (ISS-9346, PRD-706 R10-06).
 *
 * Returns the CHAMPION's controller/view-model pair, so the popover this drives
 * is the same `FilterPopover` Branches, the Agents workspace and Documents
 * render rather than a fourth private menu.
 *
 * The state round-trips through the LIST URL, following
 * `useUrlSyncedBranchFilterState` (`packages/app/branches/hooks/
 * use-branch-filter-state.ts`) and reusing its two shared helpers rather than
 * repeating them: seeded from the URL on mount, written back on every change
 * through a history-neutral `replace`. The requirement is a SHAREABLE filtered
 * view, which is why this is the URL and not `useViewStatePersistence` —
 * localStorage restores a view for one browser and cannot be sent to anybody.
 * Sort already lives in the URL here through `useSortParams`, so before this
 * the page half-remembered: a reload brought the sort back and dropped the
 * filter that produced it (tamsinb review).
 */

type ProjectFilters = TableFiltersState<ProjectStatus, Priority>;

function toggleValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

/**
 * One chip per ACTIVE category, so the strip and the predicate agree about what
 * is narrowing: a category the predicate ignores when empty must not show a
 * chip when empty either.
 */
function activeChipsFor(
  filters: ProjectFilters,
  currentUserId: string | undefined
): TableFilterChip[] {
  const chips: TableFilterChip[] = [];
  // The signed-in user is counted ONCE even when both the toggle and their own
  // row are on: the predicate ORs them, so two would name one person twice.
  const assigneeCount =
    filters.assigneeIds.length +
    (filters.assignToMe && !filters.assigneeIds.includes(currentUserId ?? "")
      ? 1
      : 0);
  if (assigneeCount > 0) {
    chips.push({ category: "assignee", label: `Assignee: ${assigneeCount}` });
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
    // Names the field the user picked AND the window they set — the menu offers
    // both fields and five windows, so a bare "Updated" cannot say which is
    // narrowing. The preset words come from the canonical map the popover draws
    // them from, so the chip and the menu row cannot say different things.
    const fieldLabel =
      filters.date.field === TableDateFilterField.CreatedAt
        ? "Created"
        : "Updated";
    chips.push({
      category: "date",
      label: `${fieldLabel}: ${TABLE_DATE_PRESET_LABELS[filters.date.preset]}`,
    });
  }
  return chips;
}

function withCategoryCleared(
  filters: ProjectFilters,
  category: TableFilterCategory
): ProjectFilters {
  if (category === "assignee") {
    return { ...filters, assigneeIds: [], assignToMe: false };
  }
  if (category === "status") {
    return { ...filters, statuses: [] };
  }
  if (category === "priority") {
    return { ...filters, priorities: [] };
  }
  if (category === "date") {
    return { ...filters, date: null };
  }
  return filters;
}

export type ProjectListFilters = {
  filters: ProjectFilters;
  controller: TableFiltersController<ProjectStatus, Priority>;
  viewModel: TableFiltersViewModel<ProjectStatus, Priority>;
  currentUserId: string | undefined;
  clearAll: () => void;
};

export function useProjectListFilters(
  projects: readonly ProjectWithDetails[]
): ProjectListFilters {
  const searchParams = useSearchParamsValue();
  const routePath = usePath();
  // Mount-only seed, exactly as `useUrlSyncedBranchFilterState` does it:
  // `initialFacetParamsSource` falls back to the browser URL while the web App
  // Router snapshot is still reconciling (empty) on a reload or a deep link,
  // scoped to THIS surface's path so another list's `?status=` still in the
  // address bar mid-transition cannot seed this one. On the desktop hash
  // router the snapshot is synchronous and `location.search` sits outside the
  // hash, so the fallback never fires there and the seed is the snapshot —
  // which is correct, not a gap: it is the same value the router already holds.
  const [initialFilters] = useState(() =>
    parseProjectFilterParams(initialFacetParamsSource(searchParams, routePath))
  );
  const [filters, setFilters] = useState<ProjectFilters>(initialFilters);
  const {
    data: users,
    error: usersError,
    isLoading: usersLoading,
  } = useOrganizationUsers();
  const { data: signedInUser } = useCurrentUser();
  const currentUser = useFilterCurrentUser(signedInUser);

  // History-neutral `replace` through the shared list-URL writer, so a filter
  // gesture never pushes a history entry and every write re-asserts the active
  // facets from state rather than from a snapshot that may still be
  // reconciling. It copies the WHOLE snapshot and touches only the names
  // `writeProjectFilterParams` owns, which is what leaves `sortBy`/`sortDir`
  // standing — see `PROJECT_RESERVED_PARAMS`.
  const replaceFilterParams = useReplaceListParams(writeProjectFilterParams);

  // The latest filters, read by `applyFilters` so an updater resolves against
  // current state WITHOUT doing the URL write inside a `setFilters` updater —
  // an updater must be pure, and React may call it twice.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const applyFilters = useCallback(
    (next: ProjectFilters | ((current: ProjectFilters) => ProjectFilters)) => {
      const resolved =
        typeof next === "function" ? next(filtersRef.current) : next;
      setFilters(resolved);
      replaceFilterParams(resolved);
    },
    [replaceFilterParams]
  );

  const clearAll = useCallback(
    () => applyFilters(EMPTY_PROJECT_FILTERS),
    [applyFilters]
  );

  const controller = useMemo<
    TableFiltersController<ProjectStatus, Priority>
  >(() => {
    return {
      filters,
      activeChips: activeChipsFor(filters, currentUser?.id),
      clearAllFilters: () => applyFilters(EMPTY_PROJECT_FILTERS),
      clearCategoryFilter: (category) =>
        applyFilters((current) => withCategoryCleared(current, category)),
      setDateFilter: (date) =>
        applyFilters((current) => ({ ...current, date })),
      toggleAssignee: (id) =>
        applyFilters((current) => ({
          ...current,
          assigneeIds: toggleValue(current.assigneeIds, id),
        })),
      toggleAssignToMe: () =>
        applyFilters((current) => ({
          ...current,
          assignToMe: !current.assignToMe,
        })),
      togglePriority: (priority) =>
        applyFilters((current) => ({
          ...current,
          priorities: toggleValue(current.priorities, priority),
        })),
      toggleStatus: (status) =>
        applyFilters((current) => ({
          ...current,
          statuses: toggleValue(current.statuses, status),
        })),
      // Projects carry no favourite, completion or tag axis on this surface, so
      // these three are declared inert rather than wired to state nothing reads.
      // The view model hides every control that would reach them — the two quick
      // toggles by name, the tags submenu by `showTags: false` — so none is.
      toggleFavoritesOnly: () => undefined,
      toggleHideCompletedItems: () => undefined,
      toggleTag: () => undefined,
    };
  }, [applyFilters, currentUser, filters]);

  /**
   * Status options are drawn from the projects actually loaded, not from the
   * whole vocabulary: a status no project holds would offer a filter that can
   * only ever empty the list.
   */
  const statusOptions = useMemo(() => {
    const present = new Set(projects.map((project) => project.status));
    return [...present].map((status) => ({
      id: status,
      label: PROJECT_STATUS_LABELS[status] ?? status,
    }));
  }, [projects]);

  const viewModel = useMemo<
    TableFiltersViewModel<ProjectStatus, Priority>
  >(() => {
    return {
      currentUser,
      // Projects carry no completion or favourite axis on this surface, so
      // neither quick toggle that would narrow by one is rendered — a control
      // that narrows nothing is a lie about what the menu can do. "Assigned to
      // me" stays: it is the one quick toggle this surface answers.
      hideCompletedToggle: true,
      hideFavoritesToggle: true,
      labels: {
        assignee: "Assignee",
        dates: "Dates",
        priority: "Priority",
        status: "Status",
      },
      priorityOptions: Object.entries(PRIORITY_LABELS).map(
        ([value, label]) => ({ id: value as Priority, label })
      ),
      showTags: false,
      statusOptions,
      teamMembers: (users ?? []).map((user) => ({
        id: user.id,
        label: getUserDisplayName(user),
      })),
      // An empty list means "this team has nobody", so a still-loading or
      // failed `/users` must not be spelled as one: `FilterPopover` renders a
      // loading row and an error row from these two, and without them a blip
      // reads as a team with no members (ISS-9346 review, whitlockk).
      teamMembersError: usersError ? usersError.message : null,
      teamMembersLoading: usersLoading,
    };
  }, [currentUser, statusOptions, users, usersError, usersLoading]);

  return {
    clearAll,
    controller,
    currentUserId: currentUser?.id,
    filters,
    viewModel,
  };
}
