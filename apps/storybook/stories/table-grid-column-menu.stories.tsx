import { ColumnOptionsMenu } from "@repo/design-system/components/ui/table-grid-column-menu";
import type { Meta, StoryObj } from "@storybook/react";
import { type ReactNode, useState } from "react";
import { expect, fn, screen, userEvent, within } from "storybook/test";

// The per-column options menu `TableGridHeader` grows under GridTable v2.
// The point of this story is the TRIGGER's state machine, which is invisible in
// a composed grid and has been lost by a from-scratch re-derivation before:
//  - at rest it is `opacity-0` — the header row reads as labels, not controls;
//  - it reveals on hover of the enclosing header (`group/header`);
//  - it reveals on KEYBOARD focus too (`focus-visible`), or the control is
//    mouse-only and a keyboard user focuses an invisible button (WCAG 2.4.7);
//  - it STAYS visible while its own menu is open (`data-[state=open]`), or it
//    fades out the moment the pointer moves onto the popup it just opened.
// Each story below mounts the trigger inside a `group/header` host that mimics a
// header cell, so hovering the row — not just the button — is what reveals it,
// exactly as in the grid.
/**
 * The options button in one column's header for sorting, filtering, grouping
 * or moving that column, handling one column at a time rather than the whole
 * table like the Table View Menu.
 */
const meta = {
  title: "Primitives/Overlays/Table Grid Column Menu",
  component: ColumnOptionsMenu,
  tags: ["autodocs"],
  argTypes: {
    label: {
      control: "text",
      table: { category: "Content" },
      description:
        "Header text, also used to name the trigger for a screen reader.",
    },
    columnId: {
      control: "text",
      table: { category: "Content" },
      description: "Id handed back to every action callback.",
    },
    sortable: {
      control: "boolean",
      table: { category: "State" },
      description:
        "Adds the two sort items. Sort never summons the menu on its own, it only rides along.",
    },
    filterable: { control: "boolean", table: { category: "State" } },
    groupable: { control: "boolean", table: { category: "State" } },
    movable: { control: "boolean", table: { category: "State" } },
    sortDir: {
      options: ["asc", "desc"],
      control: { type: "radio" },
      table: { category: "State" },
    },
    actions: {
      control: false,
      table: { category: "Events" },
      description:
        "Optional per-column callbacks. An item renders only when its action is wired here and the column opts in.",
    },
    onSort: { control: false, table: { category: "Events" } },
  },
  parameters: {
    layout: "padded",
  },
  args: {
    label: "Owner",
    columnId: "owner",
    sortable: true,
    filterable: true,
    groupable: true,
    movable: true,
    sortDir: "desc",
    actions: { onFilter: fn(), onGroup: fn(), onMove: fn() },
    onSort: fn(),
  },
} satisfies Meta<typeof ColumnOptionsMenu>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The full menu: sort, filter, group, and the Move submenu. Sort rides along
 * because filter/group/move already earned the menu — it never summons one on
 * its own (the header label already sorts).
 */
export const FullMenu: Story = {
  render: () => {
    const [lastAction, setLastAction] = useState("none");
    return (
      <div className="flex flex-col gap-3">
        <HeaderCellHost>
          <ColumnOptionsMenu
            actions={{
              onFilter: (id) => setLastAction(`filter ${id}`),
              onGroup: (id) => setLastAction(`group ${id}`),
              onMove: (id, direction) =>
                setLastAction(`move ${id} ${direction}`),
            }}
            columnId="owner"
            filterable
            groupable
            label="Owner"
            movable
            onSort={(id, direction) => setLastAction(`sort ${id} ${direction}`)}
            sortable
            sortDir="desc"
          />
        </HeaderCellHost>
        <p className="text-muted-foreground text-xs">
          Last action: <span className="font-medium">{lastAction}</span>
        </p>
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Owner column options" })
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Filter" })
    );
    // "Last action: " and the value live in separate nodes, so this matches
    // the value node directly rather than the combined text.
    await expect(canvas.getByText("filter owner")).toBeVisible();
  },
};

/**
 * A column that opted into filter only. The menu holds one item — the trigger
 * never opens something empty, and never offers an action the table did not
 * wire.
 */
export const FilterOnly: Story = {
  render: () => (
    <HeaderCellHost>
      <ColumnOptionsMenu
        actions={{
          onFilter: () => {
            // Presentation-only story.
          },
        }}
        columnId="owner"
        filterable
        label="Owner"
        onSort={() => {
          // Not sortable in this story.
        }}
        sortDir="desc"
      />
    </HeaderCellHost>
  ),
};

/**
 * A column that opted into move only. Sort is absent, so the Move submenu
 * carries no leading separator — the separator exists to divide Move from
 * whatever came before it, and there is nothing before it here.
 */
export const MoveOnly: Story = {
  render: () => (
    <HeaderCellHost>
      <ColumnOptionsMenu
        actions={{
          onMove: () => {
            // Presentation-only story.
          },
        }}
        columnId="owner"
        label="Owner"
        movable
        onSort={() => {
          // Not sortable in this story.
        }}
        sortDir="asc"
      />
    </HeaderCellHost>
  ),
};

/**
 * Two hosts side by side so the resting vs. hovered states are comparable in one
 * frame: hover either cell to see its trigger fade in, then Tab to it to see the
 * keyboard twin do the same.
 */
export const RestingVersusRevealed: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      {["Owner", "Status"].map((label) => (
        <HeaderCellHost key={label}>
          <ColumnOptionsMenu
            actions={{
              onFilter: () => {
                // Presentation-only story.
              },
            }}
            columnId={label.toLowerCase()}
            filterable
            label={label}
            onSort={() => {
              // Presentation-only story.
            }}
            sortable
            sortDir="desc"
          />
        </HeaderCellHost>
      ))}
    </div>
  ),
};

function HeaderCellHost({ children }: { children: ReactNode }) {
  return (
    <div className="group/header flex h-10 w-64 items-center rounded-sm border px-3 transition-colors duration-100 hover:bg-muted/40">
      <span className="truncate font-medium text-muted-foreground text-xs">
        Owner
      </span>
      {children}
    </div>
  );
}
