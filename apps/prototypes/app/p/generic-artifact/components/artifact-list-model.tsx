// biome-ignore-all lint/style/noExcessiveLinesPerFile: The artifact-list prototype keeps its shared configuration in one reviewable model during convergence.
"use client";

import {
  ActivityIcon,
  CircleDotDashedIcon,
  GitCommitIcon,
  Layers2Icon,
  type LinkIcon,
  MessageSquareIcon,
  Settings2Icon,
  ShapesIcon,
  TagIcon,
  UserIcon,
} from "lucide-react";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  ArtifactKind,
  type ArtifactSessionTrace,
  ArtifactStatus,
  type GenericArtifact,
  genericArtifactSessionTrace,
  genericArtifacts,
} from "../mock";
import type { ArtifactCreationConfig } from "./artifact-creation";
import { ArtifactTypeIcons } from "./artifact-icons";
import type { CustomFieldDefinition } from "./custom-field-dialog";
import type { FilterMenuGroup } from "./experimental/filter-popover";
import {
  TableDateFilterField,
  TableDatePreset,
  type TableFilterCategory,
  type TableFiltersController,
  type TableFiltersViewModel,
} from "./experimental/filter-popover";
import type { GridTableColumn } from "./experimental/grid-table";

export type ArtifactListSummaryMetric = {
  delta: number;
  info: { how: string; what: string };
  key: string;
  label: string;
  value: string;
};

export type ArtifactListColumnExtension = GridTableColumn & {
  filterRange?: (artifact: GenericArtifact) => number;
  filterValues?: (artifact: GenericArtifact) => string[];
  groupValue?: (artifact: GenericArtifact) => string;
  renderCell: (artifact: GenericArtifact) => ReactNode;
  sortValue?: (artifact: GenericArtifact) => number | string;
  width: string;
};

export type GenericArtifactListShellProps = {
  addArtifactOpen?: boolean;
  additionalColumns?: readonly ArtifactListColumnExtension[];
  artifacts?: readonly GenericArtifact[];
  buildSummaryMetrics?: (
    artifacts: readonly GenericArtifact[]
  ) => ArtifactListSummaryMetric[];
  creationConfig?: ArtifactCreationConfig;
  dateFilterLabel?: string;
  defaultVisibleColumnIds?: readonly string[];
  excludedColumnIds?: readonly string[];
  /**
   * Lightweight, keyboard-first creation that lives inside the table. Drafts
   * stay transient until a non-empty title is committed; the full creation
   * dialog remains the canonical path for richer initial metadata.
   */
  inlineCreate?: {
    enabled?: boolean;
    label?: string;
  };
  legacyColumnAliases?: Readonly<Record<string, readonly string[]>>;
  legacyMetricAliases?: Readonly<Record<string, readonly string[]>>;
  onAddArtifactOpenChange?: (open: boolean) => void;
  onArtifactsChange?: (artifacts: readonly GenericArtifact[]) => void;
  onOpenArtifact: (artifact: GenericArtifact) => void;
  onOpenArtifactHref?: (artifact: GenericArtifact) => string | undefined;
  relatedSessionsForArtifact?: (
    artifact: GenericArtifact
  ) => ArtifactSessionTrace;
  selectionNoun?: { plural: string; singular: string };
  statusBoard?: ArtifactStatusBoardConfig;
  showAddArtifactButton?: boolean;
  /** Exposes status-scoped creation in editable board columns. */
  showBoardAddButton?: boolean;
  showAddFieldButton?: boolean;
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

export type ArtifactStatusBoardConfig = {
  /** Status changes are user-authored unless the source system owns lifecycle. */
  editable: boolean;
  sourceLabel?: string;
  statuses: readonly {
    label?: string;
    status: ArtifactStatus;
  }[];
};

export type ArtifactFilters = {
  mineOnly: boolean;
  favoritesOnly: boolean;
  owners: string[];
  statuses: ArtifactStatus[];
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
export const inlineEditorRadioItemClassName =
  "pl-2 [&>span:first-child]:hidden";

export const EDITABLE_OWNERS = [
  { name: "Andrew Eye", initials: "AE" },
  { name: "Parker Byrd", initials: "PB" },
  { name: "Sam Chen", initials: "SC" },
  { name: "Jordan Lee", initials: "JL" },
] as const;

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

export type TagColor =
  | "none"
  | "red"
  | "orange"
  | "yellow-orange"
  | "yellow"
  | "yellow-green"
  | "green"
  | "blue-green"
  | "aqua"
  | "blue"
  | "indigo"
  | "purple"
  | "magenta"
  | "hot-pink"
  | "pink"
  | "cool-gray";

export type TagDefinition = {
  label: string;
  color: TagColor;
};

export const TAG_COLOR_OPTIONS: readonly {
  color: TagColor;
  swatchClassName: string;
  chipClassName: string;
}[] = [
  {
    color: "none",
    swatchClassName: "bg-muted",
    chipClassName: "border-border bg-muted text-muted-foreground",
  },
  {
    color: "red",
    swatchClassName: "bg-red-400",
    chipClassName:
      "border-red-500/25 bg-red-500/15 text-red-700 dark:text-red-300",
  },
  {
    color: "orange",
    swatchClassName: "bg-orange-400",
    chipClassName:
      "border-orange-500/25 bg-orange-500/15 text-orange-700 dark:text-orange-300",
  },
  {
    color: "yellow-orange",
    swatchClassName: "bg-amber-400",
    chipClassName:
      "border-amber-500/25 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
  {
    color: "yellow",
    swatchClassName: "bg-yellow-300",
    chipClassName:
      "border-yellow-500/25 bg-yellow-500/15 text-yellow-700 dark:text-yellow-300",
  },
  {
    color: "yellow-green",
    swatchClassName: "bg-lime-300",
    chipClassName:
      "border-lime-500/25 bg-lime-500/15 text-lime-700 dark:text-lime-300",
  },
  {
    color: "green",
    swatchClassName: "bg-green-400",
    chipClassName:
      "border-green-500/25 bg-green-500/15 text-green-700 dark:text-green-300",
  },
  {
    color: "blue-green",
    swatchClassName: "bg-emerald-400",
    chipClassName:
      "border-emerald-500/25 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  {
    color: "aqua",
    swatchClassName: "bg-cyan-300",
    chipClassName:
      "border-cyan-500/25 bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  },
  {
    color: "blue",
    swatchClassName: "bg-blue-400",
    chipClassName:
      "border-blue-500/25 bg-blue-500/15 text-blue-700 dark:text-blue-300",
  },
  {
    color: "indigo",
    swatchClassName: "bg-indigo-400",
    chipClassName:
      "border-indigo-500/25 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  },
  {
    color: "purple",
    swatchClassName: "bg-purple-400",
    chipClassName:
      "border-purple-500/25 bg-purple-500/15 text-purple-700 dark:text-purple-300",
  },
  {
    color: "magenta",
    swatchClassName: "bg-fuchsia-400",
    chipClassName:
      "border-fuchsia-500/25 bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300",
  },
  {
    color: "hot-pink",
    swatchClassName: "bg-pink-400",
    chipClassName:
      "border-pink-500/25 bg-pink-500/15 text-pink-700 dark:text-pink-300",
  },
  {
    color: "pink",
    swatchClassName: "bg-rose-300",
    chipClassName:
      "border-rose-500/25 bg-rose-500/15 text-rose-700 dark:text-rose-300",
  },
  {
    color: "cool-gray",
    swatchClassName: "bg-slate-400",
    chipClassName:
      "border-slate-500/25 bg-slate-500/15 text-slate-700 dark:text-slate-300",
  },
] as const;

export const INITIAL_TAG_DEFINITIONS: TagDefinition[] = EDITABLE_TAGS.map(
  (label, index) => ({
    label,
    color:
      TAG_COLOR_OPTIONS[(index % (TAG_COLOR_OPTIONS.length - 1)) + 1].color,
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
    info: {
      what: "Artifacts of the selected type created in the current range.",
      how: "Counted from artifacts matching the active filters.",
    },
  },
  {
    key: "token-spend",
    label: "Est. Total",
    delta: 8,
    info: {
      what: "Known API costs plus estimated subscription costs for matched artifacts.",
      how: "Adds direct API charges to the API-equivalent estimate of subscription-based token usage from linked creation and revision sessions.",
    },
  },
  {
    key: "creation-cost",
    label: "Median token cost",
    delta: -6,
    info: {
      what: "Median estimated token cost to create one matched artifact.",
      how: "Creation-session cost per artifact, using the median to reduce outliers.",
    },
  },
  {
    key: "metric-four",
    label: "Metric #4",
    delta: -14,
    info: {
      what: "Reserved for a common metric relevant to this artifact type.",
      how: "The artifact type defines the metric, aggregation, and comparison behavior.",
    },
  },
  {
    key: "metric-five",
    label: "Metric #5",
    delta: 6,
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
  [ArtifactKind.Issue]: ArtifactTypeIcons.Issue,
  [ArtifactKind.Prototype]: ArtifactTypeIcons.Prototype,
  [ArtifactKind.Session]: ArtifactTypeIcons.Session,
};

export const statusChipClass = {
  [ArtifactStatus.Active]: "border-success/25 bg-success/10 text-success",
  [ArtifactStatus.Approved]: "border-success/25 bg-success/10 text-success",
  [ArtifactStatus.Archived]: "border-border bg-muted text-muted-foreground",
  [ArtifactStatus.Backlog]: "border-border bg-muted text-muted-foreground",
  [ArtifactStatus.Canceled]: "border-border bg-muted text-muted-foreground",
  [ArtifactStatus.Completed]: "border-border bg-muted text-muted-foreground",
  [ArtifactStatus.Deprecated]:
    "border-destructive/25 bg-destructive/10 text-destructive",
  [ArtifactStatus.Done]: "border-success/25 bg-success/10 text-success",
  [ArtifactStatus.Draft]: "border-border bg-muted text-muted-foreground",
  [ArtifactStatus.Failed]:
    "border-destructive/25 bg-destructive/10 text-destructive",
  [ArtifactStatus.InProgress]: "border-info/25 bg-info/10 text-info",
  [ArtifactStatus.InReview]: "border-warning/25 bg-warning/10 text-warning",
  [ArtifactStatus.NeedsYou]:
    "border-destructive/25 bg-destructive/10 text-destructive",
  [ArtifactStatus.Published]: "border-success/25 bg-success/10 text-success",
  [ArtifactStatus.ReadyForReview]:
    "border-warning/25 bg-warning/10 text-warning",
  [ArtifactStatus.Running]: "border-info/25 bg-info/10 text-info",
  [ArtifactStatus.Todo]: "border-border bg-muted text-muted-foreground",
  [ArtifactStatus.Triage]: "border-warning/25 bg-warning/10 text-warning",
};

export const genericArtifactColumns: readonly (GridTableColumn & {
  width: string;
})[] = [
  {
    id: "owner",
    label: "Owner",
    filterable: true,
    groupable: true,
    width: "130px",
    sortable: true,
    tooltip:
      "The single accountable owner. Distinct from collaborators and contributors.",
  },
  {
    id: "collaborators",
    label: "Collaborators",
    width: "130px",
  },
  {
    filterable: true,
    groupable: true,
    id: "status",
    label: "Status",
    sortable: true,
    width: "110px",
  },
  { id: "comments", label: "Comments", width: "100px", sortable: true },
  {
    filterable: true,
    id: "updated",
    label: "Updated",
    sortable: true,
    width: "100px",
  },
  {
    id: "currentVersion",
    label: "Current version",
    width: "110px",
    sortable: true,
  },
  {
    filterable: true,
    id: "tags",
    label: "Tags",
    width: "160px",
  },
];

export const RELATED_SESSIONS_COLUMN_ID = "relatedSessions";
const REFERENCE_TIME_PATTERN = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i;

export type ReferenceOption = {
  icon: typeof LinkIcon;
  id: string;
  lastInteractionAt?: string;
  lastInteractionDate?: string;
  lastInteractionTraceRow?: number;
  ownerInitials?: string;
  ownerName?: string;
  relationship?: "commented" | "wrote";
  slug: string;
  status?: "active" | "completed";
  title: string;
};

export function relatedSessionOptions(
  artifact: GenericArtifact,
  trace: ArtifactSessionTrace
): ReferenceOption[] {
  const artifactKey = artifact.slug.split("-").at(-1) ?? artifact.slug;
  return trace.sessions
    .map((session, index) => ({
      icon: ArtifactTypeIcons.Session,
      id: session.id,
      lastInteractionAt: session.lastInteractionAt ?? session.startedAt,
      lastInteractionDate: session.lastInteractionDate,
      lastInteractionTraceRow: session.lastInteractionTraceRow,
      ownerInitials: session.contributorInitials,
      ownerName: session.contributor,
      relationship:
        session.relationship ??
        (session.title.toLowerCase().includes("comment")
          ? "commented"
          : "wrote"),
      slug: `SES-${artifactKey}-${index + 1}`,
      status:
        session.status ??
        (index === trace.sessions.length - 1 ? "active" : "completed"),
      title: session.title,
    }))
    .sort(compareRelatedSessionsByRecency);
}

function compareRelatedSessionsByRecency(
  left: ReferenceOption,
  right: ReferenceOption
): number {
  const recencyDifference =
    relatedSessionSortValue(right) - relatedSessionSortValue(left);
  if (recencyDifference !== 0) {
    return recencyDifference;
  }
  if (left.status === right.status) {
    return 0;
  }
  return left.status === "active" ? -1 : 1;
}

function relatedSessionSortValue(option: ReferenceOption): number {
  const timeMatch = option.lastInteractionAt
    ?.trim()
    .match(REFERENCE_TIME_PATTERN);
  if (!timeMatch) {
    return 0;
  }
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const period = timeMatch[3]?.toLowerCase();
  if (period === "pm" && hour !== 12) {
    hour += 12;
  } else if (period === "am" && hour === 12) {
    hour = 0;
  }
  const today = new Date();
  const day = option.lastInteractionDate
    ? Date.parse(`${option.lastInteractionDate}T00:00:00`)
    : new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate()
      ).getTime();
  return (Number.isNaN(day) ? 0 : day) + (hour * 60 + minute) * 60_000;
}

export const defaultRelatedSessionsForArtifact = () =>
  genericArtifactSessionTrace;

export function isCustomFieldSortable(field: CustomFieldDefinition): boolean {
  return !["Multi-select", "Reference (multi)"].includes(field.type);
}

export function isCustomFieldGroupable(field: CustomFieldDefinition): boolean {
  return ["Single-select", "Date", "People", "Reference"].includes(field.type);
}

export type ArtifactFilterController = TableFiltersController<
  ArtifactStatus,
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
      label: `Status: ${filters.statuses.join(", ")}`,
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
  artifacts: readonly GenericArtifact[]
): TableFiltersViewModel<ArtifactStatus, ArtifactKind> {
  return {
    currentUser: { id: "Andrew Eye", name: "Andrew Eye" },
    teamMembers: [...new Set(artifacts.map((item) => item.owner))].map(
      (owner) => ({ id: owner, label: owner })
    ),
    statusOptions: Object.values(ArtifactStatus).map((status) => ({
      id: status,
      label: status,
    })),
    priorityOptions: Object.values(ArtifactKind).map((kind) => ({
      id: kind,
      label: kind,
      icon: (() => {
        const Icon = kindIcon[kind];
        return <Icon className="size-3.5" />;
      })(),
    })),
    priorityIcon: <Layers2Icon className="size-3.5" />,
    // Completed work remains visible by default and there is intentionally no
    // separate "Hide completed" quick toggle on artifact list surfaces. Status
    // is the canonical way to include or exclude completed artifacts.
    hideCompletedToggle: true,
    tagOptions: [...new Set(artifacts.flatMap((item) => item.tags))].map(
      (tag) => ({ id: tag, label: tag })
    ),
    labels: {
      filterButton: "Filters",
      assignToMe: "Created by me",
      favoritesOnly: "Favorites",
      assignee: "Owner",
      priority: "Type",
      dates: "Updated",
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
    `$${artifacts
      .reduce((total, artifact) => total + artifact.aiSpend, 0)
      .toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`,
    `$${median(artifacts.map((artifact) => artifact.aiSpend)).toFixed(2)}`,
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

export function customFieldValues(
  artifact: GenericArtifact,
  field: CustomFieldDefinition
): { textValues: string[]; numericValue?: number } {
  const createdValue = artifact.creationValues?.[field.id];
  if (typeof createdValue === "number") {
    return { numericValue: createdValue, textValues: [] };
  }
  if (typeof createdValue === "string") {
    return { textValues: createdValue ? [createdValue] : [] };
  }
  if (Array.isArray(createdValue)) {
    return { textValues: [...createdValue] };
  }
  const showEmptyState = Number(artifact.id.split("-").at(-1)) % 3 === 0;
  if (showEmptyState) {
    return { textValues: [] };
  }
  const optionIndex = artifact.title.length % (field.options?.length || 1);
  switch (field.type) {
    case "Single-select":
      return { textValues: [field.options?.[optionIndex] ?? ""] };
    case "Multi-select":
      return { textValues: field.options?.slice(0, 2) ?? [] };
    case "Date":
      return {
        textValues: [`Jul ${20 + (artifact.title.length % 9)}, 2026`],
      };
    case "People":
      return { textValues: [artifact.owner] };
    case "Reference":
      return {
        textValues: customFieldReferenceValues(field, artifact).slice(0, 1),
      };
    case "Reference (multi)":
      return {
        textValues: customFieldReferenceValues(field, artifact).slice(0, 3),
      };
    case "Time":
      return {
        textValues: [],
        numericValue: 12 + artifact.title.length,
      };
    case "Number":
      return {
        textValues: [],
        numericValue: 100 + artifact.title.length * 7,
      };
    case "Text":
      return { textValues: ["Custom text value"] };
    default:
      return { textValues: [] };
  }
}

export function customFieldReferenceValues(
  field: CustomFieldDefinition,
  artifact?: GenericArtifact
): string[] {
  const source = field.sources?.[0];
  const sourceKind = source ? REFERENCE_SOURCE_KINDS[source] : undefined;
  if (source && !sourceKind) {
    return [];
  }
  const candidates = genericArtifacts.filter(
    (item) => !sourceKind || item.kind === sourceKind
  );
  if (!artifact || candidates.length < 2) {
    return candidates.map((item) => item.slug);
  }
  const startIndex = artifact.title.length % candidates.length;
  return [
    ...candidates.slice(startIndex),
    ...candidates.slice(0, startIndex),
  ].map((item) => item.slug);
}

export function matchesCustomFieldFilters(
  artifact: GenericArtifact,
  fields: CustomFieldDefinition[],
  filters: Record<string, CustomFieldFilter>
): boolean {
  return fields.every((field) => {
    const filter = filters[field.id];
    if (!filter) {
      return true;
    }
    const values = customFieldValues(artifact, field);
    const matchesSelected =
      !filter.selectedValues?.length ||
      filter.selectedValues.some((selected) =>
        values.textValues.includes(selected)
      );
    const matchesMin =
      filter.min === undefined ||
      (values.numericValue !== undefined && values.numericValue >= filter.min);
    const matchesMax =
      filter.max === undefined ||
      (values.numericValue !== undefined && values.numericValue <= filter.max);
    return matchesSelected && matchesMin && matchesMax;
  });
}

export function buildCustomFieldFilterGroups(
  fields: CustomFieldDefinition[],
  artifacts: readonly GenericArtifact[],
  filters: Record<string, CustomFieldFilter>,
  setFilters: React.Dispatch<
    React.SetStateAction<Record<string, CustomFieldFilter>>
  >
): FilterMenuGroup[] {
  return fields.map((field) => {
    const filter = filters[field.id] ?? {};
    if (field.type === "Number" || field.type === "Time") {
      return {
        kind: "range",
        id: field.id,
        label: field.label,
        icon: <Settings2Icon className="size-3.5" />,
        min: filter.min,
        max: filter.max,
        minPlaceholder: "Min",
        maxPlaceholder: "Max",
        onChange: (next) =>
          setFilters((current) => ({
            ...current,
            [field.id]: next,
          })),
      };
    }
    const optionValues = [
      ...new Set(
        artifacts.flatMap(
          (artifact) => customFieldValues(artifact, field).textValues
        )
      ),
    ].filter(Boolean);
    return {
      id: field.id,
      label: field.label,
      icon: <Settings2Icon className="size-3.5" />,
      options: optionValues.map((value) => ({ id: value, label: value })),
      selectedValues: filter.selectedValues ?? [],
      onToggle: (value) =>
        setFilters((current) => ({
          ...current,
          [field.id]: {
            ...current[field.id],
            selectedValues: toggleArrayValue(
              current[field.id]?.selectedValues ?? [],
              value
            ),
          },
        })),
    };
  });
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
        icon: <ExtensionFieldIcon columnId={column.id} />,
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
      icon: <ExtensionFieldIcon columnId={column.id} />,
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
      options: options.map((value) => ({ id: value, label: value })),
      selectedValues: filter.selectedValues ?? [],
    });
  }
  return groups;
}

function ExtensionFieldIcon({ columnId }: { columnId: string }) {
  const Icon =
    {
      comments: MessageSquareIcon,
      currentVersion: GitCommitIcon,
      owner: UserIcon,
      "related-branches": ArtifactTypeIcons.Branch,
      relatedSessions: ArtifactTypeIcons.Session,
      status: CircleDotDashedIcon,
      tags: TagIcon,
      type: ShapesIcon,
      updated: ActivityIcon,
    }[columnId] ?? Settings2Icon;
  return <Icon className="size-4 text-muted-foreground" />;
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
    const values = column.filterValues(artifact);
    return selected.some((value) => values.includes(value));
  });
}
