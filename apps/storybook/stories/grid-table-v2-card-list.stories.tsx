/**
 * The champion grid's narrow-surface layout — ISS-9296.
 *
 * This is the other half of how one list surface renders across web and a
 * Desktop window: below the card-fallback breakpoint the grid does not shrink,
 * it is REPLACED by this stacked list. Exactly one of the two renders, never
 * both.
 *
 * It paints no `row`, no `gridcell` and no roving tab stop, so none of the
 * grid's keyboard model reaches it — which is why the disclosure it reuses is
 * configured differently here than in the grid, and why that difference is the
 * thing these stories are about. The parity claim PRD-713 makes is not "both
 * layouts exist"; it is that a reader gets the same FACTS from either, and a
 * card list that painted only root rows, or that painted descendants the user
 * had closed, would break it while still looking fine.
 *
 * Applicable states: default (ungrouped), grouped, collapsed group, nested
 * subgroups, partial (a band with no rows), the nested-row disclosure, and
 * keyboard/pointer interaction — each with a story that renders it.
 * Not applicable: hover, focus-visible, selected, editing, dragging, drag-over,
 * disabled, read-only, permission, narrow and overflow — the cards own those,
 * this component is the list that stacks them, and it IS the narrow state.
 */
import { GridTableV2Card } from "@repo/design-system/components/ui/grid-table-v2-card";
import {
  TableChoiceCell,
  TablePersonCell,
} from "@repo/design-system/components/ui/table-cell-primitives";
import type { GridRenderRow } from "@repo/design-system/lib/grid-table-v2-tree";
import type { GridTableV2Group } from "@repo/design-system/lib/grid-table-v2-types";
import type { Meta, StoryObj } from "@storybook/react";
import { FolderIcon } from "lucide-react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import {
  GridTableV2CardItem,
  GridTableV2CardList,
} from "./support/frozen-grid-table-v2-card-list";

const meta = {
  title: "Composites v1.0/Data Display/Tables/Grid Table V2 Card List",
  tags: ["deprecated"],
  component: GridTableV2CardList,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof GridTableV2CardList>;

export default meta;

type Story = StoryObj<typeof meta>;

type StoryRow = { id: string; owner: string; status: string; title: string };

const COLUMNS = [
  { id: "status", label: "Status" },
  { id: "owner", label: "Owner" },
] as const;

/** Generated, so no assertion depends on a particular row's content. */
const ROWS: StoryRow[] = [
  { id: "row-1", owner: "Pascoe Birchall", status: "Active", title: "Alpha" },
  { id: "row-2", owner: "Pascoe Birchall", status: "Draft", title: "Bravo" },
  { id: "row-3", owner: "Dana Wu", status: "Active", title: "Charlie" },
];

const ACTIVE_GROUP = "Active";
const DRAFT_GROUP = "Draft";

const ACTIVE_PATTERN = /Active/;
const DRAFT_PATTERN = /Draft/;
const CHILD_TITLE = "Alpha child";
const EMPTY_GROUP = "Archived";
const EMPTY_GROUP_PATTERN = /Archived/;

/** Owners in fixture order, so the subgroup assertions address bands by name. */
const OWNERS = [...new Set(ROWS.map((row) => row.owner))];

/** Built once at module scope, per `useTopLevelRegex`. */
const OWNER_PATTERNS = OWNERS.map((owner) => new RegExp(owner));

/** Satisfies each story's `args` type; every story renders through its own harness. */
const BASE_ARGS = {
  afterGroupNodes: new Map(),
  afterRowsNode: null,
  collapsedGroups: new Set<string>(),
  beginSiblingWalk: () => (items: readonly StoryRow[]) =>
    items.map(toRenderRow),
  groupDropHandlers: () => ({}),
  groupIcon: null,
  renderCardItem: () => null,
  showGroupCounts: true,
  ungroupedRows: [],
  toggleGroup: () => undefined,
};

/** A flat list: every row is a card, and no section header is painted. */
export const Ungrouped: Story = {
  args: BASE_ARGS,
  render: () => <CardListStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    for (const row of ROWS) {
      await expect(canvas.getByText(row.title)).toBeInTheDocument();
    }

    // No grouping means no disclosure furniture at all — an ungrouped list that
    // still rendered a header would claim a structure the data does not have.
    await expect(canvas.queryAllByRole("button")).toHaveLength(0);
  },
};

/**
 * Grouped. Each section is a `GroupSectionHeader` disclosure, and collapsing one
 * removes its cards while leaving every other section untouched.
 *
 * The count beside each label is asserted because it is the number a reader uses
 * to decide whether a collapsed section is worth opening — a header that kept a
 * stale count would invite them to open an empty one.
 */
export const Grouped: Story = {
  args: BASE_ARGS,
  render: () => <CardListStory grouped />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const active = canvas.getByRole("button", { name: ACTIVE_PATTERN });
    await expect(active).toHaveAttribute("aria-expanded", "true");

    // Both sections are open, so every row is on screen.
    for (const row of ROWS) {
      await expect(canvas.getByText(row.title)).toBeInTheDocument();
    }

    await userEvent.click(active);

    // The collapsed section's cards are GONE, not merely hidden by a class.
    await expect(
      canvas.getByRole("button", { name: ACTIVE_PATTERN })
    ).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.queryByText("Alpha")).toBeNull();
    await expect(canvas.queryByText("Charlie")).toBeNull();

    // Its neighbour is untouched — collapsing one section must not close another.
    await expect(
      canvas.getByRole("button", { name: DRAFT_PATTERN })
    ).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByText("Bravo")).toBeInTheDocument();

    // And the count survives the collapse, so the header still says what is
    // inside the section the reader just closed.
    await expect(
      canvas.getByRole("button", { name: ACTIVE_PATTERN })
    ).toHaveTextContent("2");
  },
};

/**
 * A second grouping level, plus a band that is legitimately EMPTY.
 *
 * Both are branches nothing else in this file reaches: `CardSubgroup`
 * (`grid-table-v2-card-list.tsx`) renders only when a group carries `subgroups`,
 * and an empty band exercises the case a filter routinely produces.
 *
 * The empty band still renders its header rather than vanishing — a band that
 * disappeared when it emptied would tell the reader the category does not exist
 * rather than that nothing is in it, and its `0` is the answer to the question
 * they filtered to ask.
 */
export const NestedGroupsAndEmptyGroup: Story = {
  args: BASE_ARGS,
  render: () => <CardListStory subgrouped />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The owner subgroups render beneath their status band...
    for (const pattern of OWNER_PATTERNS) {
      await expect(
        canvas.getByRole("button", { name: pattern })
      ).toHaveAttribute("aria-expanded", "true");
    }

    // ...and collapsing ONE subgroup leaves its siblings open.
    await userEvent.click(
      canvas.getByRole("button", { name: OWNER_PATTERNS[0] })
    );
    await expect(
      canvas.getByRole("button", { name: OWNER_PATTERNS[0] })
    ).toHaveAttribute("aria-expanded", "false");
    await expect(
      canvas.getByRole("button", { name: OWNER_PATTERNS[1] })
    ).toHaveAttribute("aria-expanded", "true");

    // The empty band keeps its header and states its own count honestly.
    const emptyBand = canvas.getByRole("button", { name: EMPTY_GROUP_PATTERN });
    await expect(emptyBand).toBeInTheDocument();
    await expect(emptyBand).toHaveTextContent("0");
  },
};

/**
 * A row with children, in the layout that paints no row.
 *
 * This is the case `declaresExpandedState` exists for: the grid publishes
 * `aria-expanded` on the treegrid ROW, but there is no row here, so the CONTROL
 * has to carry it or the open/closed state reaches assistive tech nowhere
 * (WCAG 4.1.2). The card list is also required to reuse the SAME disclosure
 * rather than a read-only projection of it — a fallback that painted only roots
 * would put children out of reach on a phone.
 */
export const NestedRows: Story = {
  args: BASE_ARGS,
  render: () => <CardListStory nested />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // No rows exist in this layout, which is precisely why the control must
    // publish the state itself.
    await expect(canvas.queryAllByRole("row")).toHaveLength(0);

    const disclosure = canvas.getByRole("button", { name: "Expand row" });
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.queryByText(CHILD_TITLE)).toBeNull();

    await userEvent.click(disclosure);

    // The child is reachable here, not only in the grid.
    await expect(
      canvas.getByRole("button", { name: "Collapse row" })
    ).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByText(CHILD_TITLE)).toBeInTheDocument();
  },
};

/** A flat render row — `tree: null` is exactly "the caller opted into no nesting". */
function toRenderRow(item: StoryRow): GridRenderRow<StoryRow> {
  return { item, rowId: item.id, tree: null };
}

function renderCard(item: StoryRow) {
  return (
    <GridTableV2Card
      fields={COLUMNS.map((column) => ({
        key: column.id,
        label: column.label,
        value:
          column.id === "owner" ? (
            <TablePersonCell person={{ name: item.owner }} />
          ) : (
            <TableChoiceCell label={item.status} />
          ),
      }))}
      header={<span className="font-medium text-sm">{item.title}</span>}
    />
  );
}

function CardListStory({
  grouped = false,
  nested = false,
  subgrouped = false,
}: {
  grouped?: boolean;
  nested?: boolean;
  subgrouped?: boolean;
}) {
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    new Set()
  );
  const [expandedRowIds, setExpandedRowIds] = useState<ReadonlySet<string>>(
    new Set()
  );

  const toggleGroup = (key: string) =>
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  const flatGroups = [ACTIVE_GROUP, DRAFT_GROUP].map((status) => ({
    items: ROWS.filter((row) => row.status === status),
    key: status,
    label: status,
  }));

  // A band split by OWNER beneath the status band, plus a band that legitimately
  // holds nothing — the two branches `CardSubgroup` and an empty `items` take.
  const nestedGroups = [
    {
      items: ROWS.filter((row) => row.status === ACTIVE_GROUP),
      key: ACTIVE_GROUP,
      label: ACTIVE_GROUP,
      subgroups: [...new Set(ROWS.map((row) => row.owner))].map((owner) => ({
        items: ROWS.filter(
          (row) => row.status === ACTIVE_GROUP && row.owner === owner
        ),
        key: owner,
        label: owner,
      })),
    },
    { items: [], key: EMPTY_GROUP, label: EMPTY_GROUP },
  ];

  let groups: GridTableV2Group<StoryRow>[] | undefined;
  if (subgrouped) {
    groups = nestedGroups;
  } else if (grouped) {
    groups = flatGroups;
  }

  const nestedRows: GridRenderRow<StoryRow>[] = nested
    ? buildNestedRows(expandedRowIds)
    : ROWS.map(toRenderRow);

  return (
    <main className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-sm">
        <GridTableV2CardList
          afterGroupNodes={new Map()}
          afterRowsNode={null}
          beginSiblingWalk={() => (items) => items.map(toRenderRow)}
          collapsedGroups={collapsedGroups}
          groupDropHandlers={() => ({})}
          groupIcon={
            <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
          }
          groups={groups}
          renderCardItem={(row) => (
            <GridTableV2CardItem
              afterNode={null}
              columns={COLUMNS}
              key={row.rowId}
              onToggleExpanded={(rowId, expanded) =>
                setExpandedRowIds((previous) => {
                  const next = new Set(previous);
                  if (expanded) {
                    next.add(rowId);
                  } else {
                    next.delete(rowId);
                  }
                  return next;
                })
              }
              render={renderCard}
              row={row}
            />
          )}
          showGroupCounts
          toggleGroup={toggleGroup}
          ungroupedRows={nestedRows}
        />
      </div>
    </main>
  );
}

/** One expandable parent, whose child appears only while the parent is open. */
function buildNestedRows(
  expandedRowIds: ReadonlySet<string>
): GridRenderRow<StoryRow>[] {
  const parent = ROWS[0];
  const isExpanded = expandedRowIds.has(parent.id);
  const rows: GridRenderRow<StoryRow>[] = [
    {
      item: parent,
      rowId: parent.id,
      tree: {
        hasChildren: true,
        isExpanded,
        level: 1,
        posInSet: 1,
        setSize: 1,
      },
    },
  ];

  if (isExpanded) {
    rows.push({
      item: { ...parent, id: "row-1-child", title: CHILD_TITLE },
      rowId: "row-1-child",
      tree: {
        hasChildren: false,
        isExpanded: false,
        level: 2,
        posInSet: 1,
        setSize: 1,
      },
    });
  }

  return rows;
}
