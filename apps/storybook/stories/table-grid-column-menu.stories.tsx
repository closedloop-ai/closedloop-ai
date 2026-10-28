import {
  ColumnOptionsMenu,
  hasColumnMenuItems,
} from "@repo/design-system/components/ui/table-grid-column-menu";
import type { Meta, StoryObj } from "@storybook/react";
import { type ReactNode, useState } from "react";
import { expect, userEvent, within } from "storybook/test";

/**
 * The per-column options menu `TableGridHeader` (v1) grows under it — ISS-9314.
 *
 * The point of this story is the TRIGGER's state machine, which is invisible in
 * a composed grid and has been lost by a from-scratch re-derivation before:
 *
 *  - at rest it is `opacity-0` — the header row reads as labels, not controls;
 *  - it reveals on hover of the enclosing header (`group/header`);
 *  - it reveals on KEYBOARD focus too (`focus-visible`), or the control is
 *    mouse-only and a keyboard user focuses an invisible button (WCAG 2.4.7);
 *  - it STAYS visible while its own menu is open (`data-[state=open]`), or it
 *    fades out the moment the pointer moves onto the popup it just opened.
 *
 * Each story below mounts the trigger inside a `group/header` host that mimics a
 * header cell, so hovering the row — not just the button — is what reveals it,
 * exactly as in the grid.
 *
 * ## Taxonomy
 * Design System / Data Display **primitive** — the v1 twin of
 * `HeaderActionsMenu`, catalogued as
 * `Composites/Data Display/Tables/Table Grid Header V2 Label`. They are NOT the
 * same component: see that story's own doc block for the concrete
 * class-list, `alignEnd`/`tooltip`/`getFilterContent` divergences this pass
 * found between the two and did not merge (ISS-10146).
 *
 * `ColumnOptionsMenu` itself gates each MENU ITEM on its own capability flag
 * (`filterable`/`groupable`/`movable` each paired with the matching
 * `actions.on*`), but does **not** gate whether the TRIGGER renders at all —
 * that gate is the caller's (`hasColumnMenuItems`, applied in
 * `table-grid-header.tsx` before it even mounts this component). A caller
 * that skips that check and renders this unconditionally gets a real button
 * that opens a menu with nothing in it but "Sort" if the column happens to be
 * sortable. `WithNoWiredCapabilities` demonstrates the real, composed
 * pattern — this component beside the gate that decides whether to mount it —
 * rather than leaving that contract implicit.
 *
 * ## State matrix — which of the 16 apply
 * - **default, hover, focus-visible** — every story below; the reveal classes
 *   are pinned directly in `TriggerRevealClasses` per this repo's lesson that
 *   `toBeVisible()` cannot catch a CSS-only regression in jsdom.
 * - **selected, editing, dragging, drag-over, loading, empty, partial,
 *   error, disabled, read-only, permission, narrow** — not applicable, for
 *   the same reasons as `HeaderActionsMenu`'s sibling doc: this is a stateless
 *   presentational menu with no data, edit, drag, or capability-boolean prop
 *   of its own — capability is expressed by omission (no `filterable`,
 *   no `movable`, ...), covered by `WithNoWiredCapabilities`.
 * - **overflow** — not applicable to the trigger (a fixed glyph button); the
 *   label it sits beside is `TableGridHeader`'s own concern.
 *
 * `@storybook/addon-a11y` is not wired into this Storybook — the assertions
 * below are real DOM/attribute/class checks, not an automated axe scan.
 */
const meta = {
  title: "Composites v1.0/Data Display/Tables/Table Grid Column Menu",
  component: ColumnOptionsMenu,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    columnId: { control: "text" },
    label: { control: "text" },
    sortDir: { control: "select", options: ["asc", "desc"] },
    filterable: { control: "boolean" },
    groupable: { control: "boolean" },
    movable: { control: "boolean" },
    sortable: { control: "boolean" },
    // A capability-flag/callback bag, not a scalar — each story wires it
    // directly rather than through a generic control.
    actions: { table: { disable: true } },
    onSort: { table: { disable: true } },
  },
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof ColumnOptionsMenu>;

export default meta;

type Story = StoryObj<typeof meta>;

const TRIGGER_NAME = "Owner column options";

/**
 * The full menu: sort, filter, group, and the Move submenu. Sort rides along
 * because filter/group/move already earned the menu — it never summons one on
 * its own (the header label already sorts).
 *
 * Every action is asserted by CALLING it through the real menu item and
 * checking the callback actually ran with the real column id, not by
 * re-deriving what a click should do.
 */
export const FullMenu: Story = {
  render: (args) => {
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
            columnId={args.columnId ?? "owner"}
            filterable={args.filterable ?? true}
            groupable={args.groupable ?? true}
            label={args.label ?? "Owner"}
            movable={args.movable ?? true}
            onSort={(id, direction) => setLastAction(`sort ${id} ${direction}`)}
            sortable={args.sortable ?? true}
            sortDir={args.sortDir ?? "desc"}
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
    const trigger = canvas.getByRole("button", { name: TRIGGER_NAME });
    const body = within(globalThis.document.body);

    await userEvent.click(trigger);
    await userEvent.click(
      await body.findByRole("menuitem", { name: "Sort ascending" })
    );
    await expect(canvas.getByText("sort owner asc")).toBeInTheDocument();

    await userEvent.click(trigger);
    await userEvent.click(
      await body.findByRole("menuitem", { name: "Filter" })
    );
    await expect(canvas.getByText("filter owner")).toBeInTheDocument();

    await userEvent.click(trigger);
    await userEvent.click(
      await body.findByRole("menuitem", { name: "Group by this column" })
    );
    await expect(canvas.getByText("group owner")).toBeInTheDocument();

    await userEvent.click(trigger);
    await userEvent.click(await body.findByRole("menuitem", { name: "Move" }));
    await userEvent.click(await body.findByRole("menuitem", { name: "Left" }));
    await expect(canvas.getByText("move owner left")).toBeInTheDocument();
  },
};

/**
 * A column that opted into filter only. The menu holds exactly that one item —
 * no Sort (not sortable), no Group, no Move — the trigger never offers an
 * action the table did not wire.
 */
export const FilterOnly: Story = {
  args: { filterable: true },
  render: (args) => (
    <HeaderCellHost>
      <ColumnOptionsMenu
        actions={{
          onFilter: () => {
            // Presentation-only story.
          },
        }}
        columnId={args.columnId ?? "owner"}
        filterable={args.filterable}
        groupable={args.groupable}
        label={args.label ?? "Owner"}
        movable={args.movable}
        onSort={() => {
          // Not sortable in this story.
        }}
        sortable={args.sortable}
        sortDir={args.sortDir ?? "desc"}
      />
    </HeaderCellHost>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: TRIGGER_NAME }));
    const body = within(globalThis.document.body);

    await expect(
      await body.findByRole("menuitem", { name: "Filter" })
    ).toBeInTheDocument();
    await expect(
      body.queryByRole("menuitem", { name: "Sort ascending" })
    ).toBeNull();
    await expect(body.queryByRole("menuitem", { name: "Move" })).toBeNull();
    await expect(body.queryAllByRole("menuitem")).toHaveLength(1);
  },
};

/**
 * A column that opted into move only. Sort is absent, so the Move submenu
 * carries no leading separator — the separator exists to divide Move from
 * whatever came before it, and there is nothing before it here.
 */
export const MoveOnly: Story = {
  args: { movable: true },
  render: (args) => (
    <HeaderCellHost>
      <ColumnOptionsMenu
        actions={{
          onMove: () => {
            // Presentation-only story.
          },
        }}
        columnId={args.columnId ?? "owner"}
        filterable={args.filterable}
        groupable={args.groupable}
        label={args.label ?? "Owner"}
        movable={args.movable}
        onSort={() => {
          // Not sortable in this story.
        }}
        sortable={args.sortable}
        sortDir={args.sortDir ?? "asc"}
      />
    </HeaderCellHost>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: TRIGGER_NAME }));
    const body = within(globalThis.document.body);

    await expect(
      await body.findByRole("menuitem", { name: "Move" })
    ).toBeInTheDocument();
    // Move is the ONLY item — no separator element renders with nothing
    // preceding it to divide from.
    await expect(body.queryAllByRole("menuitem")).toHaveLength(1);
    await expect(body.queryByRole("separator")).toBeNull();
  },
};

/**
 * Two hosts side by side so the resting vs. hovered states are comparable in one
 * frame: hover either cell to see its trigger fade in, then Tab to it to see the
 * keyboard twin do the same.
 */
export const RestingVersusRevealed: Story = {
  args: { filterable: true, sortable: true },
  render: (args) => (
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
            filterable={args.filterable}
            groupable={args.groupable}
            label={label}
            movable={args.movable}
            onSort={() => {
              // Presentation-only story.
            }}
            sortable={args.sortable}
            sortDir={args.sortDir ?? "desc"}
          />
        </HeaderCellHost>
      ))}
    </div>
  ),
};

/**
 * The trigger's reveal/focus/open classes, pinned directly on the class
 * string rather than a rendered opacity jsdom has no CSS engine to compute.
 */
export const TriggerRevealClasses: Story = {
  args: { filterable: true },
  render: (args) => (
    <HeaderCellHost>
      <ColumnOptionsMenu
        actions={{ onFilter: () => undefined }}
        columnId={args.columnId ?? "owner"}
        filterable={args.filterable}
        groupable={args.groupable}
        label={args.label ?? "Owner"}
        movable={args.movable}
        onSort={() => undefined}
        sortable={args.sortable}
        sortDir={args.sortDir ?? "asc"}
      />
    </HeaderCellHost>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: TRIGGER_NAME });
    const classes = trigger.classList;

    await expect(classes.contains("opacity-0")).toBe(true);
    await expect(classes.contains("group-hover/header:opacity-100")).toBe(true);
    await expect(classes.contains("focus-visible:opacity-100")).toBe(true);
    await expect(classes.contains("data-[state=open]:opacity-100")).toBe(true);

    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute("data-state", "open");
  },
};

/**
 * The real composed pattern: `hasColumnMenuItems` decides whether
 * `ColumnOptionsMenu` mounts at all, exactly as `table-grid-header.tsx` uses
 * it. A column with no capability flags and no wired actions gets NO trigger
 * button, not a trigger that opens an empty menu — the gate this component
 * itself does not enforce on its own render.
 */
export const WithNoWiredCapabilities: Story = {
  args: { filterable: false, groupable: false, movable: false },
  render: (args) => {
    // No `actions` are wired regardless of the capability flags, so toggling
    // any of `filterable`/`groupable`/`movable` on in Controls demonstrates
    // `hasColumnMenuItems` staying false anyway (the ACTION must be wired
    // too) — flip `actions` below in source to see the trigger actually gate
    // open instead.
    const capabilities = {
      actions: {},
      filterable: args.filterable ?? false,
      groupable: args.groupable ?? false,
      movable: args.movable ?? false,
    };
    return (
      <HeaderCellHost>
        {hasColumnMenuItems(capabilities) ? (
          <ColumnOptionsMenu
            actions={capabilities.actions}
            columnId={args.columnId ?? "owner"}
            filterable={capabilities.filterable}
            groupable={capabilities.groupable}
            label={args.label ?? "Owner"}
            movable={capabilities.movable}
            onSort={() => undefined}
            sortable={args.sortable}
            sortDir={args.sortDir ?? "asc"}
          />
        ) : null}
      </HeaderCellHost>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole("button", { name: TRIGGER_NAME })
    ).toBeNull();
  },
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
