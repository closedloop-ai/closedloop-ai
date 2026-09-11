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
import { expect, screen, userEvent, within } from "storybook/test";

const FILTER_LABEL = "Filter";
const HIDE_COMPLETED_ITEM = "Hide completed items";
const FAVORITES_ITEM = "My Favorites";
const STATUS_SUBMENU = "Status";
// The status rows render their option count after the label, so these match on
// the label only rather than pinning a count that is fixture detail.
const IN_REVIEW_ROW = /^In Review/;
const DRAFT_ROW = /^Draft/;

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
  statuses: [DocumentStatus.InReview],
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
    id: DocumentStatus.InReview,
    label: "In Review",
    count: 7,
    icon: <StatusIcon size={16} status="active" />,
  },
  {
    id: DocumentStatus.Approved,
    label: "Approved",
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

/**
 * A Filter button that opens a menu of categories to add or change table
 * filters, while Active Filters Bar is the separate row of chips showing
 * what's applied.
 */
const meta = {
  title: "Composites/Data Display/Filter Popover",
  component: FilterPopoverDemo,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
  argTypes: {
    initialState: {
      control: "object",
      description:
        "Filter selections the demo controller starts with. Every key is required, so edit values rather than removing them.",
    },
    viewModel: {
      control: false,
      description:
        "Option lists and member data for the menu. Carries React nodes for the row icons, so it is set per story rather than edited here.",
    },
  },
  args: {
    initialState: baseState,
    viewModel: defaultViewModel,
  },
} satisfies Meta<typeof FilterPopoverDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Captured BEFORE the menu opens, and reused rather than re-queried:
    // Radix marks the trigger `aria-hidden` while its menu is open, which
    // removes it from every role-based query. The node itself survives, so the
    // badge stays readable through a reference taken up front.
    const trigger = canvas.getByRole("button", { name: FILTER_LABEL });

    // `baseState` applies five categories (hide-completed, status, priority,
    // date, tags), and the badge counts CATEGORIES rather than selections.
    await expect(trigger.textContent).toBe("Filter5");

    await userEvent.click(trigger);

    // Clearing one category leaves the other four applied.
    await userEvent.click(
      await screen.findByRole("menuitem", { name: HIDE_COMPLETED_ITEM })
    );
    await expect(trigger.textContent).toBe("Filter4");

    // The quick toggles `preventDefault()` on select so the menu survives a
    // toggle — without that, every assertion after the first would need the
    // menu reopened.
    await expect(
      screen.getByRole("menuitem", { name: FAVORITES_ITEM })
    ).toBeVisible();

    // Composition: an independent category ADDS to the count rather than
    // replacing what is already applied.
    await userEvent.click(
      screen.getByRole("menuitem", { name: FAVORITES_ITEM })
    );
    await expect(trigger.textContent).toBe("Filter5");

    // And toggling the same row back off is symmetric.
    await userEvent.click(
      screen.getByRole("menuitem", { name: FAVORITES_ITEM })
    );
    await expect(trigger.textContent).toBe("Filter4");

    await userEvent.keyboard("{Escape}");
  },
};

export const Empty: Story = {
  args: {
    initialState: emptyState,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: FILTER_LABEL });

    // No filters applied: the badge is absent entirely, not a zero.
    await expect(trigger.textContent).toBe("Filter");

    await userEvent.click(trigger);
    await userEvent.click(
      await screen.findByRole("menuitem", { name: HIDE_COMPLETED_ITEM })
    );
    await expect(trigger.textContent).toBe("Filter1");

    // Clearing the only applied filter REMOVES the badge rather than rendering
    // "Filter0".
    await userEvent.click(
      screen.getByRole("menuitem", { name: HIDE_COMPLETED_ITEM })
    );
    await expect(trigger.textContent).toBe("Filter");

    await userEvent.keyboard("{Escape}");
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

const facetSessionOptions: TableFilterOption[] = [
  { id: "has", label: "Has session", count: 11 },
  { id: "none", label: "No session", count: 5 },
];

function FacetFilterPopoverDemo() {
  const [statuses, setStatuses] = useState<string[]>(["open"]);
  const [owners, setOwners] = useState<string[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [sessionPresence, setSessionPresence] = useState<string[]>([]);
  const [loc, setLoc] = useState<{ min?: number; max?: number }>({});

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
          {
            id: "session",
            label: "Linked Sessions",
            options: facetSessionOptions,
            selectedValues: sessionPresence,
            onToggle: (value) => toggle(setSessionPresence, value),
          },
          {
            kind: "range",
            id: "loc",
            label: "Changes",
            min: loc.min,
            max: loc.max,
            minPlaceholder: "Min",
            maxPlaceholder: "Any",
            onChange: setLoc,
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

/**
 * The status rows live in a nested Radix submenu, reached through a sub-trigger
 * that a role query could not resolve; this drives it by its label text and
 * lets the click bubble.
 *
 * What it proves is worth the reach: the badge counts applied filter
 * CATEGORIES, not selected options, so picking a second status inside the same
 * facet must not move the count off one.
 */
export const StatusFacetSubmenu: Story = {
  args: {
    initialState: emptyState,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: FILTER_LABEL });

    await userEvent.click(trigger);
    await userEvent.click(await screen.findByText(STATUS_SUBMENU));

    await userEvent.click(await screen.findByText(IN_REVIEW_ROW));
    await expect(trigger.textContent).toBe("Filter1");

    // A second status in the SAME category is still one applied filter.
    await userEvent.click(await screen.findByText(DRAFT_ROW));
    await expect(trigger.textContent).toBe("Filter1");

    await userEvent.keyboard("{Escape}");
  },
};
