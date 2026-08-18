import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { ArtifactStatus } from "../mock";
import type { ArtifactSavedView } from "./artifact-list-controls";
import type {
  ArtifactFilters,
  ArtifactGroupOrder,
  ArtifactListLayout,
} from "./artifact-list-model";

export type SavedViewState = {
  columnIds: string[];
  dateRange: string;
  filters: ArtifactFilters;
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
  initialFilters,
  metricKeys,
  statuses,
}: {
  columnIds: string[];
  initialFilters: ArtifactFilters;
  metricKeys: string[];
  statuses: {
    active: ArtifactStatus;
    inReview: ArtifactStatus;
    needsYou: ArtifactStatus;
  };
}): SavedViewRecord[] {
  const defaultState = (): SavedViewState => ({
    columnIds,
    dateRange: "30d",
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
        dateRange: "90d",
        filters: {
          ...initialFilters,
          statuses: [statuses.inReview, statuses.needsYou],
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
