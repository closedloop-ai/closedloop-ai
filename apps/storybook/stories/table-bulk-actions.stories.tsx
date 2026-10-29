import { TableBulkActionBar } from "@repo/design-system/components/ui/table-bulk-action-bar";
import {
  type TableBulkActionDescriptor,
  TableBulkActions,
  TableBulkActionUndo,
} from "@repo/design-system/components/ui/table-bulk-actions";
import type { Meta, StoryObj } from "@storybook/react";
import { ArchiveIcon, StarIcon, TagIcon } from "lucide-react";
import { fn } from "storybook/test";

const meta = {
  title: "Composites v1.0/Data Display/Tables/Table Bulk Actions",
  tags: ["deprecated"],
  component: TableBulkActions,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TableBulkActions>;

export default meta;
type Story = StoryObj<typeof meta>;

const ROW_IDS = ["row-1", "row-2", "row-3"];
const SELECTION = { clear: fn(), retain: fn() };

/*
 * Every handler below is a spy, so none of these can hand anything back and
 * all three honestly declare `NotImplemented`. That is a fact about the stubs,
 * not about the actions they resemble: the Sessions favourite action declares
 * `Supported`, because it really does put an Undo on its toast.
 */
const FAVORITE: TableBulkActionDescriptor = {
  icon: <StarIcon />,
  id: "favorite",
  kind: "command",
  undo: TableBulkActionUndo.NotImplemented,
  label: "Favorite rows",
  onSelect: fn(),
  pressed: false,
};

const TAG: TableBulkActionDescriptor = {
  createOptionLabel: (query) => `Create “${query}”`,
  emptyLabel: "No matches",
  icon: <TagIcon />,
  id: "tags",
  kind: "picker",
  undo: TableBulkActionUndo.NotImplemented,
  label: "Add tag",
  onCreateOption: () => true,
  onSelect: () => true,
  options: [
    { id: "prototype", label: "Prototype" },
    { id: "sessions", label: "Sessions" },
  ],
  search: { label: "Search add tag", placeholder: "Search..." },
};

const ARCHIVE: TableBulkActionDescriptor = {
  icon: <ArchiveIcon />,
  id: "archive",
  kind: "command",
  undo: TableBulkActionUndo.NotImplemented,
  label: "Archive rows",
  onSelect: fn(),
};

/** The two kinds side by side: a command button and a searchable picker. */
export const Default: Story = {
  args: { actions: [FAVORITE, TAG], rowIds: ROW_IDS, selection: SELECTION },
  render: (args) => (
    <TableBulkActionBar
      actionLabel="3 rows selected"
      actions={<TableBulkActions {...args} />}
    />
  ),
};

/** Adding an operation is one more entry in the list — nothing else changes. */
export const WithAnAddedAction: Story = {
  args: {
    actions: [FAVORITE, TAG, ARCHIVE],
    rowIds: ROW_IDS,
    selection: SELECTION,
  },
  render: (args) => (
    <TableBulkActionBar
      actionLabel="3 rows selected"
      actions={<TableBulkActions {...args} />}
    />
  ),
};

/**
 * An action whose OWN mutation is in flight reads as unavailable-for-now beside
 * its live siblings. An action the host cannot offer at all is absent instead.
 */
export const WithAnActionInFlight: Story = {
  args: {
    actions: [{ ...FAVORITE, isPending: true }, TAG, ARCHIVE],
    rowIds: ROW_IDS,
    selection: SELECTION,
  },
  render: (args) => (
    <TableBulkActionBar
      actionLabel="3 rows selected"
      actions={<TableBulkActions {...args} />}
    />
  ),
};
