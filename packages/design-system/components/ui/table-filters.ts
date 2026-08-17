import type { ReactNode } from "react";

// Domain-agnostic table-filter primitives. The status/priority dimensions are
// parameterized (TStatus/TPriority, defaulting to string) so this module stays
// generic and design-system-safe; consuming surfaces supply the concrete
// flavor (e.g. @repo/app/documents/components/table/document-table-filters
// binds DocumentStatus/Priority).

export const TableDatePreset = {
  Last24h: "LAST_24H",
  Last7d: "LAST_7D",
  Last30d: "LAST_30D",
  Last3m: "LAST_3M",
  Custom: "CUSTOM",
} as const;

export type TableDatePreset =
  (typeof TableDatePreset)[keyof typeof TableDatePreset];

export const TABLE_DATE_PRESET_LABELS: Record<TableDatePreset, string> = {
  [TableDatePreset.Last24h]: "Last 24 hours",
  [TableDatePreset.Last7d]: "Last 7 days",
  [TableDatePreset.Last30d]: "Last 30 days",
  [TableDatePreset.Last3m]: "Last 3 months",
  [TableDatePreset.Custom]: "Custom range",
};

export const TableDateFilterField = {
  CreatedAt: "CREATED_AT",
  UpdatedAt: "UPDATED_AT",
} as const;

export type TableDateFilterField =
  (typeof TableDateFilterField)[keyof typeof TableDateFilterField];

export type TableDateFilter = {
  field: TableDateFilterField;
  preset: TableDatePreset;
  startDate?: Date;
  endDate?: Date;
};

export type TableFiltersState<
  TStatus extends string = string,
  TPriority extends string = string,
> = {
  assigneeIds: string[];
  assignToMe: boolean;
  hideCompletedItems: boolean;
  favoritesOnly: boolean;
  statuses: TStatus[];
  priorities: TPriority[];
  date: TableDateFilter | null;
  tagIds: string[];
};

export type TableFilterCategory =
  | "assignee"
  | "status"
  | "priority"
  | "date"
  | "hideCompleted"
  | "favorites"
  | "tags";

export type TableFilterChip = {
  category: TableFilterCategory;
  label: string;
};

export type TableFilterCurrentUser = {
  id: string;
  name: string;
  avatarUrl?: string;
};

export type TableFilterOption<TValue extends string = string> = {
  id: TValue;
  label: string;
  sectionLabel?: string;
  count?: number;
  icon?: ReactNode;
  avatarUrl?: string;
  color?: string;
  searchText?: string;
};

export type TableFilterDatePresetOption = {
  value: TableDatePreset;
  label: string;
};

/**
 * A generic multi-select facet group rendered as a submenu in `FilterPopover`.
 * Lets a surface drive the filter menu from arbitrary facets (e.g. Status /
 * Owner / Repository) instead of the built-in assignee/status/priority/dates/
 * tags set, without leaking domain concepts into the design system — callers
 * supply the options + selection + toggle handler.
 *
 * `kind` defaults to the multi-select "options" variant (backward compatible —
 * groups authored without a `kind` keep rendering as option submenus).
 */
export type FilterFacetGroup<TValue extends string = string> = {
  kind?: "options";
  id: string;
  label: string;
  icon?: ReactNode;
  options: TableFilterOption<TValue>[];
  selectedValues: TValue[];
  onToggle: (value: TValue) => void;
  submenuClassName?: string;
  /**
   * Message shown as a disabled row when `options` is empty (e.g. "No models in
   * range"). Without it an empty options facet renders as a bare search box with
   * nothing under it, which reads as broken/loading rather than "nothing to
   * filter by" — mirrors the built-in tags submenu's empty state.
   */
  emptyLabel?: string;
};

/**
 * A generic numeric min/max range facet rendered as a submenu in
 * `FilterPopover` (FEA-4003). Callers own the (clamped) `min`/`max` values and
 * the `onChange` handler; `undefined` on either end means that bound is
 * unset/open. Stays domain-agnostic — the host supplies labels and semantics.
 */
export type FilterRangeGroup = {
  kind: "range";
  id: string;
  label: string;
  icon?: ReactNode;
  min?: number;
  max?: number;
  onChange: (next: { min?: number; max?: number }) => void;
  /** Placeholder text for the min/max inputs (e.g. "0", "Any"). */
  minPlaceholder?: string;
  maxPlaceholder?: string;
  submenuClassName?: string;
};

/** Either facet variant a host can drive through `FilterPopover`. */
export type FilterMenuGroup<TValue extends string = string> =
  | FilterFacetGroup<TValue>
  | FilterRangeGroup;

export type TableFilterLabels = {
  filterButton?: string;
  filterSearchPlaceholder?: string;
  clearAll?: string;
  /**
   * Label for a SINGLE-facet clear action (e.g. the range submenu's clear
   * button), distinct from the menu-wide `clearAll`. Defaults to "Clear".
   */
  clear?: string;
  loading?: string;
  loadError?: string;
  noTags?: string;
  addFilter?: string;
  assignToMe?: string;
  hideCompletedItems?: string;
  favoritesOnly?: string;
  assignee?: string;
  status?: string;
  priority?: string;
  dates?: string;
  createdDate?: string;
  updatedDate?: string;
  tags?: string;
  unassigned?: string;
};

export type TableFiltersController<
  TStatus extends string = string,
  TPriority extends string = string,
> = {
  filters: TableFiltersState<TStatus, TPriority>;
  toggleAssignee: (id: string) => void;
  toggleAssignToMe: () => void;
  toggleHideCompletedItems: () => void;
  toggleFavoritesOnly: () => void;
  toggleStatus: (status: TStatus) => void;
  togglePriority: (priority: TPriority) => void;
  setDateFilter: (date: TableDateFilter | null) => void;
  toggleTag: (tagId: string) => void;
  clearCategoryFilter: (category: TableFilterCategory) => void;
  clearAllFilters: () => void;
  activeChips: TableFilterChip[];
};

export type TableFiltersViewModel<
  TStatus extends string = string,
  TPriority extends string = string,
> = {
  currentUser?: TableFilterCurrentUser | null;
  teamMembers: TableFilterOption[];
  teamMembersLoading?: boolean;
  teamMembersError?: string | null;
  statusOptions: TableFilterOption<TStatus>[];
  priorityOptions: TableFilterOption<TPriority>[];
  tagOptions?: TableFilterOption[];
  hideAssignee?: boolean;
  showTags?: boolean;
  datePresets?: TableFilterDatePresetOption[];
  labels?: TableFilterLabels;
  /**
   * Hide the quick-toggle section (assigned-to-me / hide-completed / favorites)
   * at the top of the menu. Used by surfaces that only want facet submenus.
   */
  hideQuickToggles?: boolean;
  /**
   * When provided, render these generic facet submenus instead of the built-in
   * assignee/status/priority/dates/tags set. The host owns the filter state and
   * toggle handlers. Each entry is either a multi-select options facet
   * (`FilterFacetGroup`) or a numeric range facet (`FilterRangeGroup`).
   */
  facetGroups?: FilterMenuGroup[];
};
