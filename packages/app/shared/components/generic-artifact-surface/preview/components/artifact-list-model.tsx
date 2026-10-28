"use client";

import { ArtifactStatus as UniversalArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { ARTIFACT_STATUS_INLINE_COLUMN_WIDTH_PX } from "@repo/app/shared/components/artifact-status/artifact-status-layout";
import type { TagColor } from "@repo/app/shared/components/tag-chip";
import { TAG_COLOR_PALETTE } from "@repo/app/shared/components/tag-color-picker";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { formatCost } from "@repo/app/shared/lib/format-utils";
import type { FilterMenuGroup } from "@repo/design-system/components/ui/filter-popover";
import {
  TableDateFilterField,
  TableDatePreset,
  type TableFilterCategory,
  type TableFiltersController,
  type TableFiltersViewModel,
} from "@repo/design-system/components/ui/filter-popover";
import {
  type MetricPolarity,
  MetricPolarity as MetricPolarityValue,
} from "@repo/design-system/components/ui/primitives/metric-polarity";
import type { TableCustomFieldDefinition as CustomFieldDefinition } from "@repo/design-system/components/ui/table-add-field-dialog";
import {
  ColumnAlignment,
  type ColumnDefinition,
  ColumnFieldKind,
  type ColumnWidthBounds,
} from "@repo/design-system/lib/column-registry";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  genericArtifactFacetForKey,
  genericArtifactFilterKeys,
  genericArtifactStatusKeyLabel,
  genericArtifactStatusMatchesKey,
  genericArtifactStatusRank,
} from "../../generic-artifact-status";
import {
  ArtifactKind,
  type ArtifactSessionTrace,
  type GenericArtifact,
} from "../fixtures";
import type { ArtifactCreationConfig } from "./artifact-creation";
import type {
  ArtifactHierarchySpec,
  ArtifactProjectMoveConfig,
} from "./artifact-hierarchy-view";
import { ArtifactTypeIcons } from "./artifact-icons";

export type ArtifactListSummaryMetric = {
  delta: number;
  deltaPolarity: MetricPolarity;
  info: { how: string; what: string };
  key: string;
  label: string;
  value: string;
};

/**
 * A column on this surface: the canonical {@link ColumnDefinition}, with `width`
 * narrowed to required. Every prototype column states its own width, and an
 * omitted bound would silently resolve to the shared 60px floor instead.
 */
export type ArtifactListColumn = ColumnDefinition & {
  width: ColumnWidthBounds;
};

/**
 * An {@link ArtifactListColumn} plus the fixture accessors this prototype
 * renders, sorts, filters and groups with. The accessors stay on THIS side of
 * the boundary — the design system's column API knows nothing about
 * `GenericArtifact`.
 */
export type ArtifactListColumnExtension = ArtifactListColumn & {
  filterOptions?: { id: string; label: string }[];
  onFilterSearchChange?: (search: string) => void;
  matchesFilter?: (
    artifact: GenericArtifact,
    selectedValues: readonly string[]
  ) => boolean;
  filterRange?: (artifact: GenericArtifact) => number;
  filterValues?: (artifact: GenericArtifact) => string[];
  valueLabel?: (value: string, artifacts: readonly GenericArtifact[]) => string;
  groupValue?: (artifact: GenericArtifact) => string;
  renderCell: (artifact: GenericArtifact) => ReactNode;
  sortValue?: (artifact: GenericArtifact) => number | string;
};

/** A pixel width from a fixture declaration as the registry's width bounds. */
export function columnWidthBounds(defaultWidthPx: number): ColumnWidthBounds {
  return { default: defaultWidthPx };
}

/**
 * Hierarchy and manual ordering are one pairing, not two independent props:
 * the reorder handle renders inside the shell's hierarchy row and
 * `useArtifactHierarchyView` yields no rows without a spec, so `manualOrdering`
 * is a silent no-op until the shell grows a flat row source (ISS-10480).
 * `false` rather than `never` so a flat surface may still state the default.
 */
type ArtifactListHierarchyProps =
  | {
      /**
       * Parent/child rendering for project collections (ISS-6560). Omitted by
       * single-artifact-type views, whose homogeneous column assumptions a
       * mixed descendant set would break.
       */
      hierarchy: ArtifactHierarchySpec;
      /** Explicit user-ordered rows, honoured only while sorting is cleared. */
      manualOrdering?: boolean;
    }
  | { hierarchy?: undefined; manualOrdering?: false };

export type GenericArtifactListShellProps = ArtifactListHierarchyProps & {
  addArtifactOpen?: boolean;
  additionalColumns?: readonly ArtifactListColumnExtension[];
  artifacts: readonly GenericArtifact[];
  /** Show only parentless artifacts as Board cards and in lane counts. */
  boardRootOnly?: boolean;
  /** Production identity replaces the sandbox fixture's current person. */
  currentUser?: { id: string; name: string };
  controlledFavoriteIds?: ReadonlySet<string>;
  /** The host's favorites read is pending, errored or malformed. */
  controlledFavoritesUnavailable?: boolean;
  /** Artifact ids whose favorite toggle the host has in flight. */
  controlledPendingFavoriteIds?: ReadonlySet<string>;
  /** Read from the host's authoritative API result, without a local row cache. */
  controlledArtifacts?: boolean;
  textFilter?: string;
  routeState?: { search: string; replace: (query: string) => void };
  persistenceKey?: string | null;
  columnCapabilities?: Readonly<
    Record<
      string,
      { filterable?: boolean; groupable?: boolean; sortable?: boolean }
    >
  >;
  buildSummaryMetrics?: (
    artifacts: readonly GenericArtifact[]
  ) => ArtifactListSummaryMetric[];
  creationConfig?: ArtifactCreationConfig;
  dateFilterLabel?: string;
  /** Grouping the surface opens with. Defaults to ungrouped. */
  defaultGroupBy?: string;
  defaultVisibleColumnIds?: readonly string[];
  excludedColumnIds?: readonly string[];
  /**
   * Cross-project moves offered from the selection toolbar. A moved subtree
   * travels whole; a moved child is promoted to a destination root.
   */
  projectMove?: ArtifactProjectMoveConfig;
  /**
   * Lightweight, keyboard-first creation that lives inside the table. Drafts
   * stay transient until a non-empty title is committed; the full creation
   * dialog remains the canonical path for richer initial metadata.
   */
  inlineCreate?: {
    onActivate?: () => void;
    enabled?: boolean;
    label?: string;
  };
  legacyColumnAliases?: Readonly<Record<string, readonly string[]>>;
  legacyMetricAliases?: Readonly<Record<string, readonly string[]>>;
  onAddArtifactOpenChange?: (open: boolean) => void;
  onArtifactsChange?: (artifacts: readonly GenericArtifact[]) => void;
  onOpenArtifact: (artifact: GenericArtifact) => void;
  /**
   * Whether creating an artifact navigates straight to it. Defaults to true; a
   * surface that files several in a row (a project backlog) turns it off and
   * keeps the creator on the list.
   */
  openCreatedArtifactAfterCreate?: boolean;
  onOpenArtifactHref?: (artifact: GenericArtifact) => string | undefined;
  relatedSessionsColumn?: ArtifactListColumnExtension;
  relatedSessionsForArtifact?: (
    artifact: GenericArtifact
  ) => ArtifactSessionTrace;
  selectionNoun?: { plural: string; singular: string };
  statusBoard?: ArtifactBoardConfig;
  showAddArtifactButton?: boolean;
  /** Exposes status-scoped creation in editable board columns. */
  showBoardAddButton?: boolean;
  showAddFieldButton?: boolean;
  /**
   * Whether this surface has a date dimension at all. Absent means the shell
   * never initializes, applies, persists or serializes a range, and a URL
   * carrying one is ignored (ISS-10479). Defaults to `showDateRangeControl`,
   * the presentational predecessor it subsumes.
   */
  hasDateDimension?: boolean;
  defaultDateRange?: string;
  /** @deprecated Alias of `hasDateDimension`; prefer the capability. */
  showDateRangeControl?: boolean;
  showSummaryCards?: boolean;
  variant?: "embedded" | "page";
  summaryMetricDefinitions?: readonly Omit<
    ArtifactListSummaryMetric,
    "value"
  >[];
};

export type ArtifactListLayout = "board" | "list";

export type ArtifactGroupOrder = "asc" | "custom" | "desc";

export type ArtifactBoardConfig = {
  /** May narrow per-row capability for a surface; never widens canonical authority. */
  editable: boolean;
  sourceLabel?: string;
};

export type ArtifactFilters = {
  mineOnly: boolean;
  favoritesOnly: boolean;
  owners: string[];
  statuses: string[];
  kinds: ArtifactKind[];
  tags: string[];
  updatedPreset: TableDatePreset | null;
};

export type CustomFieldFilter = {
  selectedValues?: string[];
  min?: number;
  max?: number;
};

export type ArtifactBulkAction =
  | "favorite"
  | "add-to-project"
  | "assign-owner"
  | "add-tag";

export const initialArtifactFilters: ArtifactFilters = {
  mineOnly: false,
  favoritesOnly: false,
  owners: [],
  statuses: [],
  kinds: [],
  tags: [],
  updatedPreset: null,
};

export const DATE_RANGES = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "60d", label: "Last 60 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
] as const;

export const PAGE_SIZES = [25, 50, 100] as const;
export const EDITABLE_TAGS = [
  "Brief",
  "Design",
  "Design system",
  "Documents",
  "Foundations",
  "Governance",
  "Platform",
  "Principles",
  "Product",
  "Prototype",
  "Research",
  "Sessions",
  "UX",
] as const;

export const REFERENCE_SOURCE_KINDS: Record<string, ArtifactKind | undefined> =
  {
    "Agentic Components": ArtifactKind.Agent,
    Branches: ArtifactKind.Branch,
    Documents: ArtifactKind.Document,
    Issues: ArtifactKind.Issue,
    // Projects are not artifact rows in this prototype fixture. Keep the source
    // explicit and empty instead of leaking Document records into a Project
    // reference picker.
    Projects: undefined,
    Prototypes: ArtifactKind.Prototype,
    Sessions: ArtifactKind.Session,
  };

/**
 * ISS-6385: the prototype used to declare its own 16-value `TagColor` union and
 * a `TAG_COLOR_OPTIONS` palette beside it — a THIRD vocabulary next to the
 * canonical `TagColor` and the `TAG_COLOR_STYLES` that render it, sharing only
 * eight names with either. Both are deleted; the definition now carries the
 * canonical colour and every swatch and chip below reads the canonical palette.
 */
export type TagDefinition = {
  label: string;
  color: TagColor;
};

export const INITIAL_TAG_DEFINITIONS: TagDefinition[] = EDITABLE_TAGS.map(
  (label, index) => ({
    label,
    color: TAG_COLOR_PALETTE[index % TAG_COLOR_PALETTE.length].name,
  })
);

export type TagEditorContextValue = {
  definitions: TagDefinition[];
  createTag: (label: string) => void;
  setTagColor: (label: string, color: TagColor) => void;
};

export const TagEditorContext = createContext<TagEditorContextValue | null>(
  null
);

export const genericSummaryMetricDefinitions = [
  {
    key: "artifacts-created",
    label: "Artifacts created",
    delta: 12,
    deltaPolarity: MetricPolarityValue.HigherIsBetter,
    info: {
      what: "Artifacts of the selected type created in the current range.",
      how: "Counted from artifacts matching the active filters.",
    },
  },
  {
    key: "token-spend",
    label: "Est. Total",
    delta: 8,
    deltaPolarity: MetricPolarityValue.LowerIsBetter,
    info: {
      what: "Known API costs plus estimated subscription costs for matched artifacts.",
      how: "Adds direct API charges to the API-equivalent estimate of subscription-based token usage from linked creation and revision sessions.",
    },
  },
  {
    key: "creation-cost",
    label: "Median token cost",
    delta: -6,
    deltaPolarity: MetricPolarityValue.LowerIsBetter,
    info: {
      what: "Median estimated token cost to create one matched artifact.",
      how: "Creation-session cost per artifact, using the median to reduce outliers.",
    },
  },
  {
    key: "metric-four",
    label: "Metric #4",
    delta: -14,
    deltaPolarity: MetricPolarityValue.Neutral,
    info: {
      what: "Reserved for a common metric relevant to this artifact type.",
      how: "The artifact type defines the metric, aggregation, and comparison behavior.",
    },
  },
  {
    key: "metric-five",
    label: "Metric #5",
    delta: 6,
    deltaPolarity: MetricPolarityValue.Neutral,
    info: {
      what: "Reserved for the outcome metric that matters for this artifact type.",
      how: "For example merge rate for branches or approval rate for documents.",
    },
  },
] as const;

export const kindIcon = {
  [ArtifactKind.Agent]: ArtifactTypeIcons.Agent,
  [ArtifactKind.Branch]: ArtifactTypeIcons.Branch,
  [ArtifactKind.Document]: ArtifactTypeIcons.Document,
  [ArtifactKind.Deployment]: ArtifactTypeIcons.Deployment,
  [ArtifactKind.Issue]: ArtifactTypeIcons.Issue,
  [ArtifactKind.Prototype]: ArtifactTypeIcons.Prototype,
  [ArtifactKind.Session]: ArtifactTypeIcons.Session,
};

export const genericArtifactColumns: readonly ArtifactListColumn[] = [
  {
    id: "owner",
    kind: ColumnFieldKind.Person,
    label: "Owner",
    filterable: true,
    groupable: true,
    width: columnWidthBounds(130),
    sortable: true,
    tooltip:
      "The single accountable owner. Distinct from collaborators and contributors.",
  },
  {
    id: "collaborators",
    kind: ColumnFieldKind.PersonList,
    label: "Collaborators",
    width: columnWidthBounds(130),
  },
  {
    filterable: true,
    groupable: true,
    id: "status",
    kind: ColumnFieldKind.Choice,
    label: "Status",
    sortable: true,
    width: {
      default: ARTIFACT_STATUS_INLINE_COLUMN_WIDTH_PX,
      min: ARTIFACT_STATUS_INLINE_COLUMN_WIDTH_PX,
    },
  },
  {
    // A count, so `Number` is the honest kind — but its kind default would
    // right-align a header the preserved baseline renders start-aligned, and
    // re-aligning the product's numeric columns is the responsive-layout
    // owner's call (see `column-layout.ts`), not this recompose's.
    align: ColumnAlignment.Start,
    id: "comments",
    kind: ColumnFieldKind.Number,
    label: "Comments",
    width: columnWidthBounds(100),
    sortable: true,
  },
  {
    filterable: true,
    id: "updated",
    kind: ColumnFieldKind.Date,
    label: "Updated",
    sortable: true,
    width: columnWidthBounds(100),
  },
  {
    id: "currentVersion",
    kind: ColumnFieldKind.Text,
    label: "Current version",
    width: columnWidthBounds(110),
    sortable: true,
  },
  {
    filterable: true,
    id: "tags",
    kind: ColumnFieldKind.ChoiceList,
    label: "Tags",
    width: columnWidthBounds(160),
  },
];

export const RELATED_SESSIONS_COLUMN_ID = "relatedSessions";

export function isCustomFieldSortable(field: CustomFieldDefinition): boolean {
  return !["Multi-select", "Reference (multi)"].includes(field.type);
}

export function isCustomFieldGroupable(field: CustomFieldDefinition): boolean {
  return ["Single-select", "Date", "People", "Reference"].includes(field.type);
}

export type ArtifactFilterController = TableFiltersController<
  string,
  ArtifactKind
>;

export function toggleArrayValue<T>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

export function buildFilterController(
  filters: ArtifactFilters,
  setFilters: Dispatch<SetStateAction<ArtifactFilters>>
): ArtifactFilterController {
  const activeChips: ArtifactFilterController["activeChips"] = [];
  if (filters.mineOnly) {
    activeChips.push({ category: "assignee", label: "Created by me" });
  } else if (filters.owners.length > 0) {
    activeChips.push({
      category: "assignee",
      label: `Owner: ${filters.owners.join(", ")}`,
    });
  }
  if (filters.favoritesOnly) {
    activeChips.push({ category: "favorites", label: "Favorites" });
  }
  if (filters.statuses.length > 0) {
    activeChips.push({
      category: "status",
      label: `Status: ${filters.statuses.map(genericArtifactStatusKeyLabel).join(", ")}`,
    });
  }
  if (filters.kinds.length > 0) {
    activeChips.push({
      category: "priority",
      label: `Type: ${filters.kinds.join(", ")}`,
    });
  }
  if (filters.updatedPreset) {
    activeChips.push({
      category: "date",
      label: `Updated: ${datePresetLabel(filters.updatedPreset)}`,
    });
  }
  if (filters.tags.length > 0) {
    activeChips.push({
      category: "tags",
      label: `Tags: ${filters.tags.join(", ")}`,
    });
  }

  return {
    filters: {
      assigneeIds: filters.owners,
      assignToMe: filters.mineOnly,
      hideCompletedItems: false,
      favoritesOnly: filters.favoritesOnly,
      statuses: filters.statuses,
      priorities: filters.kinds,
      date: filters.updatedPreset
        ? {
            field: TableDateFilterField.UpdatedAt,
            preset: filters.updatedPreset,
          }
        : null,
      tagIds: filters.tags,
    },
    toggleAssignee: (owner) =>
      setFilters((current) => ({
        ...current,
        mineOnly: false,
        owners: toggleArrayValue(current.owners, owner),
      })),
    toggleAssignToMe: () =>
      setFilters((current) => ({
        ...current,
        mineOnly: !current.mineOnly,
        owners: [],
      })),
    toggleHideCompletedItems: () => undefined,
    toggleFavoritesOnly: () =>
      setFilters((current) => ({
        ...current,
        favoritesOnly: !current.favoritesOnly,
      })),
    toggleStatus: (status) =>
      setFilters((current) => ({
        ...current,
        statuses: toggleArrayValue(current.statuses, status),
      })),
    togglePriority: (kind) =>
      setFilters((current) => ({
        ...current,
        kinds: toggleArrayValue(current.kinds, kind),
      })),
    setDateFilter: (date) =>
      setFilters((current) => ({
        ...current,
        updatedPreset: date?.preset ?? null,
      })),
    toggleTag: (tag) =>
      setFilters((current) => ({
        ...current,
        tags: toggleArrayValue(current.tags, tag),
      })),
    clearCategoryFilter: (category) =>
      setFilters((current) => clearFilterCategory(current, category)),
    clearAllFilters: () => setFilters(initialArtifactFilters),
    activeChips,
  };
}

export function clearFilterCategory(
  filters: ArtifactFilters,
  category: TableFilterCategory
): ArtifactFilters {
  switch (category) {
    case "assignee":
      return { ...filters, mineOnly: false, owners: [] };
    case "favorites":
      return { ...filters, favoritesOnly: false };
    case "status":
      return { ...filters, statuses: [] };
    case "priority":
      return { ...filters, kinds: [] };
    case "date":
      return { ...filters, updatedPreset: null };
    case "tags":
      return { ...filters, tags: [] };
    default:
      return filters;
  }
}

export function buildFilterViewModel(
  artifacts: readonly GenericArtifact[],
  currentUser = { id: "Ottilie Eastwick", name: "Ottilie Eastwick" }
): TableFiltersViewModel<string, ArtifactKind> {
  const representedKinds = [
    ...new Set(artifacts.map((artifact) => artifact.kind)),
  ];
  const statusOptions = genericArtifactFilterKeys(
    representedKinds,
    artifacts.some((artifact) => genericArtifactStatusRank(artifact) === null)
  ).flatMap((id) => {
    const facet = genericArtifactFacetForKey(representedKinds, id);
    if (!facet) {
      return [];
    }
    const label = genericArtifactStatusKeyLabel(id);
    return [
      {
        content: (
          <span
            className={
              facet.normalized.detail ? "ml-3 border-l pl-3" : undefined
            }
          >
            <UniversalArtifactStatus
              facet={facet}
              variant={ArtifactStatusVariant.FilterOption}
            />
          </span>
        ),
        count: artifacts.filter((artifact) =>
          genericArtifactStatusMatchesKey(artifact, id)
        ).length,
        id,
        label,
        searchText: label,
      },
    ];
  });
  return {
    currentUser,
    teamMembers: [
      ...new Map(
        artifacts.map((item) => [
          item.ownerId ?? item.owner,
          { id: item.ownerId ?? item.owner, label: item.owner },
        ])
      ).values(),
    ],
    statusOptions,
    // Only the kinds these rows carry, in the canonical kind order.
    priorityOptions: Object.values(ArtifactKind)
      .filter((kind) => representedKinds.includes(kind))
      .map((kind) => ({ id: kind, label: kind })),
    // Completed work remains visible by default and there is intentionally no
    // separate "Hide completed" quick toggle on artifact list surfaces. Status
    // is the canonical way to include or exclude completed artifacts.
    hideCompletedToggle: true,
    tagOptions: [
      ...new Map(
        artifacts.flatMap((item) =>
          item.tags.map((tag, index) => {
            const id = item.tagIds?.[index] ?? tag;
            return [id, { id, label: tag }] as const;
          })
        )
      ).values(),
    ],
    labels: {
      filterButton: "Filters",
      assignToMe: "Created by me",
      favoritesOnly: "Favorites",
      assignee: "Owner",
      priority: "Type",
      updatedDate: "Updated",
    },
  };
}

export function datePresetLabel(preset: TableDatePreset): string {
  switch (preset) {
    case TableDatePreset.Last24h:
      return "Last 24 hours";
    case TableDatePreset.Last7d:
      return "Last 7 days";
    case TableDatePreset.Last30d:
      return "Last 30 days";
    case TableDatePreset.Last3m:
      return "Last 3 months";
    default:
      return "Custom range";
  }
}

export function updatedPresetMinutes(
  preset: TableDatePreset | null
): number | null {
  switch (preset) {
    case TableDatePreset.Last24h:
      return 24 * 60;
    case TableDatePreset.Last7d:
      return 7 * 24 * 60;
    case TableDatePreset.Last30d:
      return 30 * 24 * 60;
    case TableDatePreset.Last3m:
      return 90 * 24 * 60;
    default:
      return null;
  }
}

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

export function buildSummaryMetrics(artifacts: readonly GenericArtifact[]) {
  const values = [
    String(artifacts.length),
    // ISS-6385: money is the shared `formatCost`, not a local `$${…toFixed(2)}`.
    formatCost(
      artifacts.reduce((total, artifact) => total + artifact.aiSpend, 0)
    ),
    formatCost(median(artifacts.map((artifact) => artifact.aiSpend))),
    String(
      Math.round(median(artifacts.map((artifact) => artifact.activityCount)))
    ),
    `${Math.round(
      median(artifacts.map((artifact) => artifact.outcomeScore))
    )}%`,
  ];
  return genericSummaryMetricDefinitions.map((metric, index) => ({
    ...metric,
    value: values[index] ?? "0",
  }));
}

export function buildExtensionFilterGroups(
  columns: readonly ArtifactListColumnExtension[],
  artifacts: readonly GenericArtifact[],
  filters: Record<string, CustomFieldFilter>,
  setFilters: Dispatch<SetStateAction<Record<string, CustomFieldFilter>>>
): FilterMenuGroup[] {
  const groups: FilterMenuGroup[] = [];
  for (const column of columns) {
    if (!(column.filterable && (column.filterValues || column.filterRange))) {
      continue;
    }
    const filter = filters[column.id] ?? {};
    if (column.filterRange) {
      groups.push({
        kind: "range",
        id: column.id,
        label: column.label,
        min: filter.min,
        max: filter.max,
        minPlaceholder: "Min",
        maxPlaceholder: "Max",
        onChange: (next) =>
          setFilters((current) => ({ ...current, [column.id]: next })),
      });
      continue;
    }
    const options = [
      ...new Set(
        artifacts.flatMap((artifact) => column.filterValues?.(artifact) ?? [])
      ),
    ].filter(Boolean);
    groups.push({
      id: column.id,
      label: column.label,
      onToggle: (value: string) =>
        setFilters((current) => ({
          ...current,
          [column.id]: {
            ...current[column.id],
            selectedValues: toggleArrayValue(
              current[column.id]?.selectedValues ?? [],
              value
            ),
          },
        })),
      onSearchChange: column.onFilterSearchChange,
      options:
        column.filterOptions ??
        options.map((value) => ({
          id: value,
          label: column.valueLabel?.(value, artifacts) ?? value,
        })),
      selectedValues: filter.selectedValues ?? [],
    });
  }
  return groups;
}

export function matchesExtensionFilters(
  artifact: GenericArtifact,
  columns: readonly ArtifactListColumnExtension[],
  filters: Record<string, CustomFieldFilter>
): boolean {
  return columns.every((column) => {
    const filter = filters[column.id] ?? {};
    if (column.filterRange) {
      const value = column.filterRange(artifact);
      return !(
        (filter.min !== undefined && value < filter.min) ||
        (filter.max !== undefined && value > filter.max)
      );
    }
    const selected = filter.selectedValues ?? [];
    if (selected.length === 0 || !column.filterValues) {
      return true;
    }
    if (column.matchesFilter) {
      return column.matchesFilter(artifact, selected);
    }
    const values = column.filterValues(artifact);
    return selected.some((value) => values.includes(value));
  });
}
