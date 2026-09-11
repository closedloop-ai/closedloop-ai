import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus } from "@repo/api/src/types/document";
import type {
  DocumentTableFiltersController,
  DocumentTableFiltersState,
  DocumentTableFiltersViewModel,
} from "@repo/app/documents/components/table/document-table-filters";
import { ActiveFiltersBar } from "@repo/design-system/components/ui/active-filters-bar";
import { FilterChip } from "@repo/design-system/components/ui/filter-chip";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import {
  TableDateFilterField,
  TableDatePreset,
  type TableFilterOption,
} from "@repo/design-system/components/ui/table-filters";
import type { Meta, StoryObj } from "@storybook/react";
import { UserIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

const defaultViewModel: DocumentTableFiltersViewModel = {
  currentUser: { id: "user_1", name: "Avery Carter", avatarUrl: "" },
  teamMembers: [
    {
      id: "__unassigned__",
      label: "Unassigned",
      count: 1,
      icon: <UserIcon className="size-4 text-muted-foreground" />,
      searchText: "unassigned",
    },
    {
      id: "user_1",
      label: "Avery Carter",
      avatarUrl: "",
      count: 4,
    },
    {
      id: "user_2",
      label: "Jordan Lee",
      avatarUrl: "",
      count: 3,
    },
  ],
  statusOptions: [
    {
      id: DocumentStatus.Draft,
      label: "Draft",
      count: 5,
      icon: <StatusIcon size={16} status="draft" />,
    },
    {
      id: DocumentStatus.InReview,
      label: "In Review",
      count: 7,
      icon: <StatusIcon size={16} status="active" />,
    },
  ] satisfies TableFilterOption<DocumentStatus>[],
  priorityOptions: [
    {
      id: Priority.Medium,
      label: "Medium",
      count: 4,
      icon: <PriorityIcon priority={Priority.Medium} size={16} />,
    },
    {
      id: Priority.High,
      label: "High",
      count: 6,
      icon: <PriorityIcon priority={Priority.High} size={16} />,
    },
  ] satisfies TableFilterOption<Priority>[],
  tagOptions: [
    { id: "tag_quality", label: "Quality", color: "#22c55e" },
    { id: "tag_customer", label: "Customer", color: "#3b82f6" },
  ],
  showTags: true,
};

const defaultState: DocumentTableFiltersState = {
  assigneeIds: ["user_1", "user_2"],
  assignToMe: false,
  hideCompletedItems: true,
  favoritesOnly: true,
  statuses: [DocumentStatus.InReview, DocumentStatus.Draft],
  priorities: [Priority.High],
  date: {
    field: TableDateFilterField.CreatedAt,
    preset: TableDatePreset.Last30d,
  },
  tagIds: ["tag_customer"],
};

const emptyState: DocumentTableFiltersState = {
  assigneeIds: [],
  assignToMe: false,
  hideCompletedItems: false,
  favoritesOnly: false,
  statuses: [],
  priorities: [],
  date: null,
  tagIds: [],
};

function buildActiveChips(filters: DocumentTableFiltersState) {
  const chips: DocumentTableFiltersController["activeChips"] = [];
  if (filters.hideCompletedItems) {
    chips.push({ category: "hideCompleted", label: "Hide completed items" });
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
    chips.push({
      category: "date",
      label: `${filters.date.field === TableDateFilterField.CreatedAt ? "Created" : "Updated"}: ${filters.date.preset}`,
    });
  }
  if (filters.tagIds.length > 0) {
    chips.push({ category: "tags", label: `Tags: ${filters.tagIds.length}` });
  }
  return chips;
}

function ActiveFiltersBarDemo({
  initialState,
  viewModel,
  extraChips,
  showFilterControls,
}: {
  initialState: DocumentTableFiltersState;
  viewModel: DocumentTableFiltersViewModel;
  extraChips?: ReactNode;
  showFilterControls?: boolean;
}) {
  const [filters, setFilters] =
    useState<DocumentTableFiltersState>(initialState);
  const controller = useMemo<DocumentTableFiltersController>(
    () => ({
      filters,
      toggleAssignee: (id) =>
        setFilters((prev) => ({
          ...prev,
          assigneeIds: prev.assigneeIds.includes(id)
            ? prev.assigneeIds.filter((value) => value !== id)
            : [...prev.assigneeIds, id],
        })),
      toggleAssignToMe: () => undefined,
      toggleHideCompletedItems: () =>
        setFilters((prev) => ({
          ...prev,
          hideCompletedItems: !prev.hideCompletedItems,
        })),
      toggleFavoritesOnly: () =>
        setFilters((prev) => ({
          ...prev,
          favoritesOnly: !prev.favoritesOnly,
        })),
      toggleStatus: (status) =>
        setFilters((prev) => ({
          ...prev,
          statuses: prev.statuses.includes(status)
            ? prev.statuses.filter((value) => value !== status)
            : [...prev.statuses, status],
        })),
      togglePriority: (priority) =>
        setFilters((prev) => ({
          ...prev,
          priorities: prev.priorities.includes(priority)
            ? prev.priorities.filter((value) => value !== priority)
            : [...prev.priorities, priority],
        })),
      setDateFilter: (date) =>
        setFilters((prev) => ({
          ...prev,
          date,
        })),
      toggleTag: (tagId) =>
        setFilters((prev) => ({
          ...prev,
          tagIds: prev.tagIds.includes(tagId)
            ? prev.tagIds.filter((value) => value !== tagId)
            : [...prev.tagIds, tagId],
        })),
      clearCategoryFilter: (category) =>
        setFilters((prev) => {
          switch (category) {
            case "assignee":
              return { ...prev, assigneeIds: [] };
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
        }),
      clearAllFilters: () => setFilters(emptyState),
      activeChips: buildActiveChips(filters),
    }),
    [filters]
  );

  return (
    <ActiveFiltersBar
      controller={controller}
      extraChips={extraChips}
      showFilterControls={showFilterControls}
      viewModel={viewModel}
    />
  );
}

/**
 * Stand-in for a surface-owned chip (FEA-1626: My Tasks' "Last 90 days" recency
 * window). Rendered through the real `FilterChip`, so the stories show the
 * actual geometry the two chip sources share.
 */
function SurfaceChip({ label }: { label: string }) {
  return <FilterChip label={label} onRemove={() => undefined} />;
}

/**
 * A row of removable chips for each active table filter, with Add and Clear
 * all buttons, while Filter Popover is the single button that adds those
 * filters.
 */
const meta = {
  title: "Composites/Data Display/Active Filters Bar",
  component: ActiveFiltersBarDemo,
  tags: ["autodocs"],
  argTypes: {
    initialState: {
      control: "object",
      description:
        "Filter state the demo seeds its local store with. Decides which chips render.",
    },
    viewModel: {
      control: false,
      description:
        "Facet options plus loading and error flags. Its option icons are React nodes, so it is set per story rather than edited here.",
    },
    extraChips: {
      control: false,
      description:
        "Surface-owned chips rendered ahead of the managed facet chips.",
    },
    showFilterControls: {
      control: "boolean",
      description:
        "Whether the trailing add filter and clear all controls render.",
    },
  },
  parameters: {
    layout: "padded",
  },
  args: {
    initialState: defaultState,
    viewModel: defaultViewModel,
    showFilterControls: true,
  },
} satisfies Meta<typeof ActiveFiltersBarDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: {
    initialState: emptyState,
  },
};

export const LoadingMembers: Story = {
  args: {
    initialState: {
      ...emptyState,
      assigneeIds: ["user_1"],
    },
    viewModel: {
      ...defaultViewModel,
      teamMembersLoading: true,
    },
  },
};

export const MemberLoadError: Story = {
  args: {
    initialState: {
      ...emptyState,
      assigneeIds: ["user_1"],
    },
    viewModel: {
      ...defaultViewModel,
      teamMembersError: "Could not load members",
    },
  },
};

export const HiddenAssignee: Story = {
  args: {
    viewModel: {
      ...defaultViewModel,
      hideAssignee: true,
    },
  },
};

/**
 * FEA-1626 — the bar carrying ONLY a surface-owned chip, with the facet
 * add/clear controls suppressed. This is the My Tasks recency window: the bar is
 * on screen purely to disclose a server-side narrowing, so a "Clear all" button
 * would sit there with nothing to clear. Worth eyeing for the lone-chip case,
 * where the strip has no facet chips to sit against.
 */
export const SurfaceChipOnly: Story = {
  args: {
    extraChips: <SurfaceChip label="Last 90 days" />,
    initialState: emptyState,
    showFilterControls: false,
  },
};

/**
 * FEA-1626 — both chip sources at once: the surface-owned chip renders ahead of
 * the managed facet chips, with the facet controls shown because facet filters
 * ARE active. The state to check for wrap and spacing — a full facet set plus a
 * caller chip is the widest this strip gets.
 */
export const SurfaceChipWithActiveFacets: Story = {
  args: {
    extraChips: <SurfaceChip label="Last 90 days" />,
    showFilterControls: true,
  },
};
