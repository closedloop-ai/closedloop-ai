import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus } from "@repo/api/src/types/document";
import type {
  DocumentTableFiltersController,
  DocumentTableFiltersState,
  DocumentTableFiltersViewModel,
} from "@repo/app/documents/components/table/document-table-filters";
import { FilterPopover } from "@repo/design-system/components/ui/filter-popover";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import {
  TableDateFilterField,
  TableDatePreset,
  type TableFilterOption,
} from "@repo/design-system/components/ui/table-filters";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import type { Meta, StoryObj } from "@storybook/react";
import { UserIcon } from "lucide-react";
import { useMemo, useState } from "react";

const teamMembers: User[] = [
  { id: "user_1", name: "Avery Carter", avatarUrl: "" },
  { id: "user_2", name: "Jordan Lee", avatarUrl: "" },
  { id: "user_3", name: "Samir Patel", avatarUrl: "" },
];

const baseState: DocumentTableFiltersState = {
  assigneeIds: [],
  assignToMe: false,
  hideCompletedItems: true,
  favoritesOnly: false,
  statuses: [DocumentStatus.InProgress],
  priorities: [Priority.High],
  date: {
    field: TableDateFilterField.UpdatedAt,
    preset: TableDatePreset.Last7d,
  },
  tagIds: ["tag_quality"],
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

const statusOptions: TableFilterOption<DocumentStatus>[] = [
  {
    id: DocumentStatus.Draft,
    label: "Draft",
    count: 5,
    icon: <StatusIcon size={16} status="draft" />,
  },
  {
    id: DocumentStatus.InProgress,
    label: "In Progress",
    count: 7,
    icon: <StatusIcon size={16} status="active" />,
  },
  {
    id: DocumentStatus.Done,
    label: "Done",
    count: 3,
    icon: <StatusIcon size={16} status="completed" />,
  },
];

const priorityOptions: TableFilterOption<Priority>[] = [
  {
    id: Priority.Low,
    label: "Low",
    count: 2,
    icon: <PriorityIcon priority={Priority.Low} size={16} />,
  },
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
];

const tagOptions: TableFilterOption[] = [
  { id: "tag_quality", label: "Quality", color: "#22c55e" },
  { id: "tag_customer", label: "Customer", color: "#3b82f6" },
  { id: "tag_design", label: "Design", color: "#ec4899" },
];

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
    ...teamMembers.map((member, index) => ({
      id: member.id,
      label: member.name,
      avatarUrl: member.avatarUrl,
      count: 4 - index,
      searchText: member.name,
    })),
  ],
  teamMembersLoading: false,
  teamMembersError: null,
  statusOptions,
  priorityOptions,
  tagOptions,
  showTags: true,
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

function FilterPopoverDemo({
  initialState,
  viewModel,
}: {
  initialState: DocumentTableFiltersState;
  viewModel: DocumentTableFiltersViewModel;
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
      toggleAssignToMe: () =>
        setFilters((prev) => {
          const assignToMe = !prev.assignToMe;
          return {
            ...prev,
            assignToMe,
            assigneeIds: assignToMe
              ? Array.from(new Set([...prev.assigneeIds, "user_1"]))
              : prev.assigneeIds.filter((id) => id !== "user_1"),
          };
        }),
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
        }),
      clearAllFilters: () => setFilters(emptyState),
      activeChips: buildActiveChips(filters),
    }),
    [filters]
  );

  return <FilterPopover controller={controller} viewModel={viewModel} />;
}

const meta = {
  title: "Design System/Primitives/Filter Popover",
  component: FilterPopoverDemo,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
  args: {
    initialState: baseState,
    viewModel: defaultViewModel,
  },
} satisfies Meta<typeof FilterPopoverDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: {
    initialState: emptyState,
  },
};

export const LoadingAssignees: Story = {
  args: {
    viewModel: {
      ...defaultViewModel,
      teamMembersLoading: true,
    },
  },
};

export const MemberLoadError: Story = {
  args: {
    viewModel: {
      ...defaultViewModel,
      teamMembersError: "Could not load members",
    },
  },
};

export const NoAssigneeFilters: Story = {
  args: {
    viewModel: {
      ...defaultViewModel,
      hideAssignee: true,
    },
  },
};

export const NoTags: Story = {
  args: {
    viewModel: {
      ...defaultViewModel,
      tagOptions: [],
      showTags: true,
    },
  },
};

// A no-op controller: the `facetGroups` path drives everything from the facet
// groups themselves and never calls controller methods (the count badge reads
// the groups directly), so surfaces that only want facet submenus can pass this.
const noopController: DocumentTableFiltersController = {
  filters: emptyState,
  toggleAssignee: () => undefined,
  toggleAssignToMe: () => undefined,
  toggleHideCompletedItems: () => undefined,
  toggleFavoritesOnly: () => undefined,
  toggleStatus: () => undefined,
  togglePriority: () => undefined,
  setDateFilter: () => undefined,
  toggleTag: () => undefined,
  clearCategoryFilter: () => undefined,
  clearAllFilters: () => undefined,
  activeChips: [],
};

const facetStatusOptions: TableFilterOption[] = [
  { id: "open", label: "Open", count: 8 },
  { id: "review", label: "In review", count: 3 },
  { id: "merged", label: "Merged", count: 12 },
];

const facetOwnerOptions: TableFilterOption[] = [
  { id: "avery", label: "Avery Carter", count: 5 },
  { id: "jordan", label: "Jordan Lee", count: 4 },
  { id: "samir", label: "Samir Patel", count: 6 },
];

const facetRepoOptions: TableFilterOption[] = [
  { id: "web", label: "acme/web", count: 9 },
  { id: "api", label: "acme/api", count: 7 },
];

function FacetFilterPopoverDemo() {
  const [statuses, setStatuses] = useState<string[]>(["open"]);
  const [owners, setOwners] = useState<string[]>([]);
  const [repos, setRepos] = useState<string[]>([]);

  const toggle = (
    setter: (updater: (prev: string[]) => string[]) => void,
    value: string
  ) =>
    setter((prev) =>
      prev.includes(value)
        ? prev.filter((entry) => entry !== value)
        : [...prev, value]
    );

  return (
    <FilterPopover
      controller={noopController}
      viewModel={{
        ...defaultViewModel,
        hideQuickToggles: true,
        facetGroups: [
          {
            id: "status",
            label: "Status",
            icon: <StatusIcon size={16} status="decorative" />,
            options: facetStatusOptions,
            selectedValues: statuses,
            onToggle: (value) => toggle(setStatuses, value),
          },
          {
            id: "owner",
            label: "Owner",
            icon: <UserIcon className="size-4" />,
            options: facetOwnerOptions,
            selectedValues: owners,
            onToggle: (value) => toggle(setOwners, value),
          },
          {
            id: "repo",
            label: "Repository",
            options: facetRepoOptions,
            selectedValues: repos,
            onToggle: (value) => toggle(setRepos, value),
          },
        ],
      }}
    />
  );
}

/**
 * Facet-group mode (used by Sessions/Branches): the quick-toggle top section is
 * hidden and the menu renders arbitrary multi-select facet submenus.
 */
export const FacetGroups: StoryObj<typeof FacetFilterPopoverDemo> = {
  render: () => <FacetFilterPopoverDemo />,
};
