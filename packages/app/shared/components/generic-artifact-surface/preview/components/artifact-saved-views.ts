import { TableDatePreset } from "@repo/design-system/components/ui/filter-popover";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { TableSavedViewScope } from "@repo/design-system/components/ui/table-toolbar-model";
import { z } from "zod";
import { ArtifactKind } from "../fixtures";
import type { ArtifactDateDimension } from "./artifact-date-dimension";
import {
  DEFAULT_ARTIFACT_DATE_RANGE,
  isArtifactDateRange,
} from "./artifact-date-dimension";
import type { ArtifactSavedView } from "./artifact-list-control-adapters";
import type {
  ArtifactFilters,
  ArtifactGroupOrder,
  ArtifactListLayout,
  CustomFieldFilter,
} from "./artifact-list-model";

export type SavedViewState = {
  columnIds: string[];
  /**
   * Omitted — never null — on a surface with no date dimension, so restoring
   * such a view cannot reintroduce a window the surface does not have.
   */
  dateRange?: string;
  filters: ArtifactFilters;
  extensionFilters?: Record<string, CustomFieldFilter>;
  customFieldFilters?: Record<string, CustomFieldFilter>;
  groupBy: string;
  groupOrder: ArtifactGroupOrder;
  secondaryGroupBy: string;
  secondaryGroupOrder: ArtifactGroupOrder;
  showEmptyGroups: boolean;
  showEmptySubgroups: boolean;
  layout: ArtifactListLayout;
  metricKeys: string[];
  sortActive: boolean;
  sortBy: string;
  sortDir: SortDirection;
};

export type SavedViewRecord = ArtifactSavedView & { state: SavedViewState };

export function buildInitialSavedViews({
  columnIds,
  dateDimension,
  initialFilters,
  metricKeys,
  statuses,
}: {
  columnIds: string[];
  dateDimension: ArtifactDateDimension;
  initialFilters: ArtifactFilters;
  metricKeys: string[];
  statuses: {
    active: string;
    inReview: string;
  };
}): SavedViewRecord[] {
  const seededRange = (range: string) =>
    dateDimension.present ? { dateRange: range } : {};
  const defaultState = (): SavedViewState => ({
    columnIds,
    ...seededRange(DEFAULT_ARTIFACT_DATE_RANGE),
    filters: initialFilters,
    groupBy: "none",
    groupOrder: "custom",
    secondaryGroupBy: "none",
    secondaryGroupOrder: "asc",
    showEmptyGroups: true,
    showEmptySubgroups: true,
    layout: "list",
    metricKeys,
    sortActive: false,
    sortBy: "name",
    sortDir: "asc",
  });
  return [
    {
      id: "default",
      name: "Default view",
      scope: "personal",
      state: defaultState(),
    },
    {
      id: "my-active-work",
      name: "My active work",
      scope: "personal",
      state: {
        ...defaultState(),
        filters: {
          ...initialFilters,
          mineOnly: true,
          statuses: [statuses.active],
        },
        sortActive: true,
        sortBy: "updated",
        sortDir: "desc",
      },
    },
    {
      id: "team-review",
      name: "Needs team review",
      scope: "team",
      state: {
        ...defaultState(),
        ...seededRange("90d"),
        filters: {
          ...initialFilters,
          statuses: [statuses.inReview],
        },
      },
    },
    {
      id: "project-recent",
      name: "Recent project activity",
      scope: "project",
      state: {
        ...defaultState(),
        groupBy: "status",
        sortActive: true,
        sortBy: "updated",
        sortDir: "desc",
      },
    },
  ];
}

const savedColumnFilterSchema = z.object({
  selectedValues: z.array(z.string()).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
});

export const artifactSavedViewRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: z.enum(TableSavedViewScope),
  state: z.object({
    columnIds: z.array(z.string()),
    metricKeys: z.array(z.string()),
    dateRange: z.string().refine(isArtifactDateRange).optional(),
    filters: z.object({
      kinds: z.array(z.enum(ArtifactKind)),
      owners: z.array(z.string()),
      statuses: z.array(z.string()),
      tags: z.array(z.string()),
      mineOnly: z.boolean(),
      favoritesOnly: z.boolean(),
      updatedPreset: z.enum(TableDatePreset).nullable(),
    }),
    customFieldFilters: z
      .record(z.string(), savedColumnFilterSchema)
      .optional(),
    extensionFilters: z.record(z.string(), savedColumnFilterSchema).optional(),
    groupBy: z.string(),
    groupOrder: z.enum(["asc", "custom", "desc"]),
    secondaryGroupBy: z.string(),
    secondaryGroupOrder: z.enum(["asc", "custom", "desc"]),
    showEmptyGroups: z.boolean(),
    showEmptySubgroups: z.boolean(),
    layout: z.enum(["board", "list"]),
    sortActive: z.boolean(),
    sortBy: z.string(),
    sortDir: z.enum(["asc", "desc"]),
  }),
}) satisfies z.ZodType<SavedViewRecord>;
