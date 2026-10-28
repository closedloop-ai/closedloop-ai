/**
 * Story fixtures for the canonical responsive projection of `GridTableV2`
 * (PRD-727). These
 * fixtures force compact mode so the stories exercise the same rows, grouping,
 * hierarchy, focus, and selection mechanics production uses below the existing
 * narrow breakpoint.
 */

import { Button } from "@repo/design-system/components/ui/button";
import { GridTableV2 } from "@repo/design-system/components/ui/grid-table-v2";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { useGridRowSelection } from "@repo/design-system/hooks/use-grid-row-selection";
import { GRID_TABLE_V2_NARROW_LEADING_LABEL } from "@repo/design-system/lib/grid-table-v2-constants";
import { gridTableV2SelectionProps } from "@repo/design-system/lib/grid-table-v2-selection";
import type {
  GridTableV2Group,
  GridTableV2Props,
} from "@repo/design-system/lib/grid-table-v2-types";
import type { Meta, StoryObj } from "@storybook/react";
import { CircleCheckIcon, CircleIcon, TagIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { expect, fireEvent, userEvent, within } from "storybook/test";

const meta = {
  title: "Composites/Shared/Artifact List/Grid Table Grouped Sections",
  tags: ["stable"],
  component: GridTableV2<StoryRow>,
  parameters: {
    controls: { disable: true },
    layout: "fullscreen",
  },
} satisfies Meta<typeof GridTableV2<StoryRow>>;

export default meta;

// No controls: every story fixes a complete production-shaped row fixture.
type Story = StoryObj<typeof meta>;
type StoryRow = {
  id: string;
  owner: string;
  status: string;
  title: string;
};

const LONG_TITLE =
  "Alpha planning artifact with a title that must truncate at phone width";
const ROWS: StoryRow[] = [
  {
    id: "row-1",
    owner: "Pascoe Birchall",
    status: "Active",
    title: LONG_TITLE,
  },
  {
    id: "row-2",
    owner: "Pascoe Birchall",
    status: "Draft",
    title: "Bravo delivery artifact",
  },
  {
    id: "row-3",
    owner: "Dana Wu",
    status: "Complete",
    title: "Charlie research artifact",
  },
];
const CHILD_ROW: StoryRow = {
  ...ROWS[0],
  id: "row-1-child",
  title: "Alpha child artifact",
};
const COLUMNS = [
  { id: "status", label: "Status" },
  { id: "owner", label: "Owner" },
] as const;
const BASE_ARGS: GridTableV2Props<StoryRow> = {
  columns: COLUMNS,
  getRowId: (row) => row.id,
  gridTemplateColumns: "minmax(12rem, 1fr) 8rem 10rem",
  items: ROWS,
  leadingLabel: "Artifact",
  mode: "compact",
  renderCell: () => null,
  renderLead: () => null,
};
const ACTIVE_GROUP_PATTERN = /Active/;
const DRAFT_GROUP_PATTERN = /Draft/;
const EMPTY_GROUP_PATTERN = /Archived/;
const PASCOE_GROUP_PATTERN = /Pascoe Birchall/;

export const NarrowDefault: Story = {
  args: BASE_ARGS,
  render: () => <NarrowListStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const headers = canvas.getAllByRole("columnheader");
    await expect(headers).toHaveLength(1);
    await expect(headers[0]).toHaveTextContent(
      GRID_TABLE_V2_NARROW_LEADING_LABEL
    );
    await expect(
      canvas.queryByRole("columnheader", { name: "Owner" })
    ).toBeNull();
    await expect(canvas.getByRole("grid")).toHaveClass("min-w-0");

    const longTitle = canvas.getByText(LONG_TITLE);
    await expect(longTitle).toHaveClass("truncate");
    await userEvent.hover(longTitle);
    await expect(
      await within(canvasElement.ownerDocument.body).findByRole("tooltip")
    ).toHaveTextContent(LONG_TITLE);
  },
};

export const Grouped: Story = {
  args: BASE_ARGS,
  render: () => <NarrowListStory groups={buildStatusGroups()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const active = canvas.getByRole("button", { name: ACTIVE_GROUP_PATTERN });
    await expect(active).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(active);
    await expect(
      canvas.getByRole("button", { name: ACTIVE_GROUP_PATTERN })
    ).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.queryByText(LONG_TITLE)).toBeNull();
    await expect(
      canvas.getByRole("button", { name: DRAFT_GROUP_PATTERN })
    ).toHaveAttribute("aria-expanded", "true");
  },
};

export const NestedGroupsAndEmptyGroup: Story = {
  args: BASE_ARGS,
  render: () => <NarrowListStory groups={buildNestedGroups()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pascoe = canvas.getByRole("button", { name: PASCOE_GROUP_PATTERN });
    await expect(pascoe).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(pascoe);
    await expect(
      canvas.getByRole("button", { name: PASCOE_GROUP_PATTERN })
    ).toHaveAttribute("aria-expanded", "false");
    const emptyGroup = canvas.getByRole("button", {
      name: EMPTY_GROUP_PATTERN,
    });
    await expect(emptyGroup).toHaveTextContent("0");
  },
};

export const NestedRows: Story = {
  args: BASE_ARGS,
  render: () => <NarrowListStory nested />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const parent = getStoryRow(canvasElement, ROWS[0].id);
    const disclosure = canvas.getByRole("button", { name: "Expand item" });
    await expect(parent).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(disclosure);
    await expect(canvas.getByText(CHILD_ROW.title)).toBeVisible();
    await expect(getStoryRow(canvasElement, ROWS[0].id)).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  },
};

export const Selected: Story = {
  args: BASE_ARGS,
  render: () => <NarrowListStory initiallySelected={[ROWS[0].id]} selectable />,
  play: async ({ canvasElement }) => {
    const row = getStoryRow(canvasElement, ROWS[0].id);
    await expect(row).toHaveAttribute("aria-selected", "true");
    const leadCell = within(row).getByRole("gridcell");
    leadCell.blur();
    for (
      let tabIndex = 0;
      tabIndex < 10 && leadCell.ownerDocument.activeElement !== leadCell;
      tabIndex += 1
    ) {
      await userEvent.tab();
    }
    await expect(leadCell).toHaveFocus();
    await expect(leadCell.matches(":focus-visible")).toBe(true);
    const view = canvasElement.ownerDocument.defaultView;
    await expect(view?.getComputedStyle(leadCell).boxShadow).not.toBe("none");
  },
};

export const NestedControl: Story = {
  args: BASE_ARGS,
  render: () => <NarrowListStory nestedControl selectable />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = getStoryRow(canvasElement, ROWS[0].id);
    const control = canvas.getByRole("button", { name: "Tag Alpha" });
    await userEvent.click(control);
    await expect(control).toHaveAttribute("data-activation-count", "1");
    await expect(row).toHaveAttribute("aria-selected", "false");
  },
};

export const GroupedSelectable: Story = {
  args: BASE_ARGS,
  render: () => <NarrowListStory groups={buildStatusGroups()} selectable />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const first = getStoryRow(canvasElement, ROWS[0].id);
    const lastActive = getStoryRow(canvasElement, ROWS[2].id);
    await fireEvent.click(first);
    await fireEvent.click(lastActive, { ctrlKey: true });
    await expect(first).toHaveAttribute("aria-selected", "true");
    await expect(lastActive).toHaveAttribute("aria-selected", "true");
    await userEvent.click(
      canvas.getByRole("button", { name: ACTIVE_GROUP_PATTERN })
    );
    await userEvent.click(
      canvas.getByRole("button", { name: ACTIVE_GROUP_PATTERN })
    );
    await expect(getStoryRow(canvasElement, ROWS[0].id)).toHaveAttribute(
      "aria-selected",
      "true"
    );
  },
};

export const SelectableTree: Story = {
  args: BASE_ARGS,
  render: () => <NarrowListStory nested selectable />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Expand item" }));
    const child = getStoryRow(canvasElement, CHILD_ROW.id);
    await fireEvent.click(child, { ctrlKey: true });
    await expect(child).toHaveAttribute("aria-selected", "true");
    await userEvent.click(
      canvas.getByRole("button", { name: "Collapse item" })
    );
    await userEvent.click(canvas.getByRole("button", { name: "Expand item" }));
    await expect(getStoryRow(canvasElement, CHILD_ROW.id)).toHaveAttribute(
      "aria-selected",
      "true"
    );
  },
};

export const Dark: Story = {
  args: BASE_ARGS,
  globals: { theme: "dark" },
  render: () => <NarrowListStory groups={buildStatusGroups()} />,
};

function NarrowListStory({
  groups,
  initiallySelected = [],
  nested = false,
  nestedControl = false,
  selectable = false,
}: {
  groups?: GridTableV2Group<StoryRow>[];
  initiallySelected?: string[];
  nested?: boolean;
  nestedControl?: boolean;
  selectable?: boolean;
}) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(initiallySelected)
  );
  const [activationCount, setActivationCount] = useState(0);
  const selection = useGridRowSelection<StoryRow>({
    controller: { onChange: setSelectedIds, selectedIds },
    visibleRowIds: [...ROWS.map((row) => row.id), CHILD_ROW.id],
  });
  const selectionProps = selectable
    ? gridTableV2SelectionProps({
        isRowSelected: (row: StoryRow) => selection.selectedIds.has(row.id),
        onRowSelection: selection.onRowSelection,
        onRowSelectionToggle: selection.toggleRowSelection,
        onSelectAllRows: selection.selectAllRows,
      })
    : undefined;
  return (
    <main className="min-h-screen bg-background p-4">
      <div className="mx-auto max-w-sm overflow-hidden rounded-md border">
        <GridTableV2<StoryRow>
          collapseRowLabel="Collapse item"
          columns={COLUMNS}
          expandRowLabel="Expand item"
          getChildren={nested ? getStoryChildren : undefined}
          getRowId={(row) => row.id}
          gridTemplateColumns="minmax(12rem, 1fr) 8rem 10rem"
          groups={groups}
          items={groups ? [] : ROWS}
          leadingLabel="Artifact"
          mode="compact"
          renderCell={(columnId, row) =>
            columnId === "owner" ? row.owner : row.status
          }
          renderLead={(row) => (
            <StoryLead row={row}>
              {nestedControl && row.id === ROWS[0].id ? (
                <Button
                  aria-label="Tag Alpha"
                  data-activation-count={activationCount}
                  onClick={() => setActivationCount((count) => count + 1)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <TagIcon />
                </Button>
              ) : null}
            </StoryLead>
          )}
          {...selectionProps}
        />
      </div>
    </main>
  );
}

function StoryLead({ children, row }: { children?: ReactNode; row: StoryRow }) {
  const StatusIcon = row.status === "Complete" ? CircleCheckIcon : CircleIcon;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <StatusIcon
        aria-label={`${row.status} status`}
        className="size-4 shrink-0 text-muted-foreground"
        role="img"
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="min-w-0 flex-1 truncate text-sm">{row.title}</span>
        </TooltipTrigger>
        <TooltipContent>{row.title}</TooltipContent>
      </Tooltip>
      {children}
    </div>
  );
}

function buildStatusGroups(): GridTableV2Group<StoryRow>[] {
  return ["Active", "Draft", "Complete"].map((status) => ({
    items: ROWS.filter((row) => row.status === status),
    key: status,
    label: status,
  }));
}

function buildNestedGroups(): GridTableV2Group<StoryRow>[] {
  return [
    {
      items: ROWS,
      key: "status-active",
      label: "Active",
      subgroups: ["Pascoe Birchall", "Dana Wu"].map((owner) => ({
        items: ROWS.filter((row) => row.owner === owner),
        key: owner,
        label: owner,
      })),
    },
    { items: [], key: "archived", label: "Archived" },
  ];
}

function getStoryChildren(row: StoryRow): readonly StoryRow[] {
  return row.id === ROWS[0].id ? [CHILD_ROW] : [];
}

function getStoryRow(canvasElement: HTMLElement, rowId: string): HTMLElement {
  const row = canvasElement.querySelector<HTMLElement>(
    `[data-grid-row-id="${rowId}"]`
  );
  if (!row) {
    throw new Error(`Grid row ${rowId} was not rendered`);
  }
  return row;
}
