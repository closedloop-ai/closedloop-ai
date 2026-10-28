import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { DropdownMenuItem } from "@repo/design-system/components/ui/dropdown-menu";
import type { TableBulkActionDescriptor } from "@repo/design-system/components/ui/table-bulk-actions";
import {
  EMPTY_TABLE_GROUPING,
  TableSavedViewScope,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { isGridChromeRowId } from "@repo/design-system/lib/grid-table-v2-chrome-rows";
import type { Meta, StoryObj } from "@storybook/react";
import { FolderPlusIcon, TagIcon, UserRoundIcon } from "lucide-react";
import {
  expect,
  fireEvent,
  fn,
  screen,
  userEvent,
  within,
} from "storybook/test";
import {
  createFullyPopulatedSessionsUsageFixture,
  createSessionTableRowFixture,
} from "./session-list-fixtures";
import { sessionsBulkPickerAction } from "./sessions-bulk-picker-action";
import type { SessionsSavedViewsController } from "./sessions-list-saved-views";
import { SessionsListSurfaceV2 } from "./sessions-list-surface-v2";
import { SessionsListSurfaceV2Preview } from "./sessions-list-surface-v2-demo";

const meta = {
  title: "Composites v1.0/Sessions/Sessions List Surface V2 Contracts",
  tags: ["deprecated"],
  component: SessionsListSurfaceV2,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SessionsListSurfaceV2>;

export default meta;

type Story = StoryObj<typeof meta>;

const FIELD_TITLE_LABEL_PATTERN = /Field title/;
const STORY_ROWS = [
  createSessionTableRowFixture({
    id: "contract-session-1",
    name: "session/contract-one",
    status: "Active",
  }),
  createSessionTableRowFixture({
    id: "contract-session-2",
    name: "session/contract-two",
    status: "Completed",
  }),
  createSessionTableRowFixture({
    id: "contract-session-3",
    name: "session/contract-three",
    status: "Failed",
  }),
];
const STORY_USAGE = {
  ...createFullyPopulatedSessionsUsageFixture(),
  totalSessions: STORY_ROWS.length,
};

export const BulkSelection: Story = {
  args: {
    bulkActions: createStoryBulkActions(),
    rows: STORY_ROWS,
    usage: STORY_USAGE,
  },
  render: (args) => (
    <SessionsListSurfaceV2Preview
      rows={args.rows}
      surfaceProps={args}
      totalRows={STORY_ROWS.length}
      usage={args.usage}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rows = Array.from(dataGridRows(canvasElement));
    fireEvent.click(
      rows[0]?.querySelector<HTMLElement>(
        '[role="gridcell"][data-column-id="status"]'
      ) as HTMLElement
    );
    fireEvent.click(
      rows[2]?.querySelector<HTMLElement>(
        '[role="gridcell"][data-column-id="status"]'
      ) as HTMLElement,
      { shiftKey: true }
    );
    for (const row of rows) {
      await expect(row).toHaveAttribute("aria-selected", "true");
    }
    const bulkActions = canvas.getByRole("toolbar", {
      name: "3 sessions selected",
    });
    await expect(bulkActions).toBeVisible();
    for (const name of [
      "Favorite sessions",
      "Add to project",
      "Assign owner",
      "Add tag",
    ]) {
      await expect(
        within(bulkActions).getByRole("button", { name })
      ).toBeVisible();
    }
  },
};

export const AddFieldContract: Story = {
  args: { rows: STORY_ROWS, usage: STORY_USAGE },
  render: (args) => (
    <SessionsListSurfaceV2Preview
      rows={args.rows}
      surfaceProps={args}
      totalRows={STORY_ROWS.length}
      usage={args.usage}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getAllByRole("button", { name: "Add field" })[0] as HTMLElement
    );
    const dialog = await screen.findByRole("dialog");
    await expect(
      within(dialog).getByRole("heading", { name: "Add field" })
    ).toBeVisible();
    await expect(within(dialog).queryByText("Allowed targets")).toBeNull();
    await expect(within(dialog).queryByText("Applies to")).toBeNull();
    await userEvent.type(
      within(dialog).getByRole("textbox", {
        name: FIELD_TITLE_LABEL_PATTERN,
      }),
      "Confidence"
    );
    await userEvent.type(
      within(dialog).getAllByPlaceholderText("Type an option name")[0],
      "High"
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create field" })
    );
    await expect(canvas.getByText("Confidence")).toBeVisible();
  },
};

export const ViewAndCreationContracts: Story = {
  args: {
    exportItem: <DropdownMenuItem>Export CSV</DropdownMenuItem>,
    inlineCreate: createStoryInlineCreate(),
    rows: STORY_ROWS,
    savedViews: createStorySavedViews(),
    usage: STORY_USAGE,
  },
  render: (args) => (
    <SessionsListSurfaceV2Preview
      rows={args.rows}
      surfaceProps={args}
      totalRows={STORY_ROWS.length}
      usage={args.usage}
    />
  ),
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Views" }));
    await expect(screen.getByText("Default view")).toBeVisible();
    fireEvent.keyDown(globalThis.document, { key: "Escape" });

    await userEvent.click(canvas.getByRole("button", { name: "Add session" }));
    const input = canvas.getByRole("textbox", { name: "Add session name" });
    await userEvent.type(input, "session/new-contract");
    fireEvent.keyDown(input, { key: "Enter" });
    await expect(args.inlineCreate?.onCreate).toHaveBeenCalledWith(
      "session/new-contract",
      {}
    );

    await userEvent.click(canvas.getByRole("button", { name: "Options" }));
    await expect(screen.getByText("Export CSV")).toBeVisible();
  },
};

function createStoryBulkActions(): readonly TableBulkActionDescriptor[] {
  return [
    sessionsBulkPickerAction({
      command: {
        options: [
          { id: "platform", label: "Platform" },
          { id: "design-system", label: "Design system" },
        ],
        onApply: () => () => undefined,
      },
      icon: <FolderPlusIcon />,
      id: "projects",
      label: "Add to project",
    }),
    sessionsBulkPickerAction({
      command: {
        options: [
          { id: "ottilie", label: "Ottilie Eastwick" },
          { id: "pascoe", label: "Pascoe Birchall" },
        ],
        onApply: () => () => undefined,
      },
      icon: <UserRoundIcon />,
      id: "owners",
      label: "Assign owner",
    }),
    sessionsBulkPickerAction({
      command: {
        options: [
          { id: "prototype", label: "Prototype" },
          { id: "sessions", label: "Sessions" },
        ],
        onApply: () => () => undefined,
        onCreateOption: (label) => ({ id: label.toLowerCase(), label }),
      },
      icon: <TagIcon />,
      id: "tags",
      label: "Add tag",
    }),
  ];
}

function createStoryInlineCreate() {
  return {
    label: "Add session",
    onCreate: fn(),
  };
}

function createStorySavedViews(): SessionsSavedViewsController {
  return {
    activeViewId: null,
    onApply: fn(),
    onSave: fn(),
    views: [
      {
        id: "default",
        name: "Default view",
        scope: TableSavedViewScope.Personal,
        value: {
          dateRange: DEFAULT_DATE_RANGE,
          facets: DEFAULT_SESSION_FACET_FILTERS,
          grouping: EMPTY_TABLE_GROUPING,
          hiddenSummaryCardIds: new Set(),
          page: 0,
          scopeUserId: null,
          sortBy: null,
          sortDir: "asc",
          visibleColumnIds: new Set(),
        },
      },
    ],
  };
}

/**
 * The DATA rows of a rendered grid, excluding chrome.
 *
 * ISS-10245 made `navigableHeaderCells` unconditional, so `GridTableV2`'s chrome
 * header row carries `data-grid-row-id` alongside the real rows — as `rows[0]`
 * it has no data cells to click, and in a count it reads as one row too many.
 */
function dataGridRows(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-grid-row-id]")].filter(
    (row) => !isGridChromeRowId(row.dataset.gridRowId ?? "")
  );
}
