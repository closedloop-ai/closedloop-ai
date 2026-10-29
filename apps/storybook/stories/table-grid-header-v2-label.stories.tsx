import {
  HeaderActionsMenu,
  HeaderLabel,
} from "@repo/design-system/components/ui/table-grid-header-v2-label";
import type { Meta, StoryObj } from "@storybook/react";
import { type ReactNode, useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

/**
 * The v2 header cell's LABEL and its per-column options menu — ISS-9314.
 *
 * Lifted out of `table-grid-header-v2.tsx` (ISS-9313) to stay under the
 * repo's 1,000-line ceiling; see that file's own header comment. Registered
 * in the generated catalog since the split, but until this story it had no
 * Storybook page of its own (`storyStatus: "catalog-only"`) — an agent or
 * reviewer could find the entry but never see what it renders, which is
 * exactly the gap ISS-9314's acceptance criteria name.
 *
 * ## Taxonomy
 * Design System / Data Display **primitive** — a pure, presentational pair
 * (`HeaderLabel`, `HeaderActionsMenu`) with no data access of its own; the
 * parent `TableGridHeaderV2` decides what to pass in.
 *
 * ## A real, undocumented duplicate this pass found — not fixed here
 * `HeaderActionsMenu` is NOT the same component as `ColumnOptionsMenu`
 * (`table-grid-column-menu.tsx`, the v1 `TableGridHeader`'s menu, its own
 * story at `Composites/Data Display/Tables/Table Grid Column Menu`). They render
 * the same idea — sort / filter / group / move in one dropdown — as two
 * independently hand-maintained implementations that have already drifted:
 *
 * - The trigger button's class list differs in real, visible ways: `size-5`
 *   vs. `size-6`, `rounded-[5px]` vs. `rounded-sm`, and `HeaderActionsMenu`'s
 *   trigger carries no `focus-visible:ring-2` — so the two menus' keyboard
 *   focus rings do not match today.
 * - `HeaderActionsMenu` accepts `actions.getFilterContent` for a custom filter
 *   submenu body; `ColumnOptionsMenu` does not — it only ever renders a plain
 *   "Filter" item calling `actions.onFilter`.
 * - `HeaderActionsMenu` supports `alignEnd` (for numeric columns, ISS-5333)
 *   and an optional `tooltip` on the label; `ColumnOptionsMenu` has neither.
 * - The Move submenu's items carry icons in `ColumnOptionsMenu`
 *   (`ChevronsLeftIcon`, `ArrowLeftIcon`, ...) and no icons in
 *   `HeaderActionsMenu`.
 *
 * Reconciling these into one champion is a real "reuse before extraction"
 * candidate per this ticket's own guardrails, but it is a behavior-affecting
 * merge (which capability set wins — `getFilterContent`, `alignEnd`, the
 * focus ring, the icons) that this Storybook/catalog pass should not decide
 * unilaterally. Filed as ISS-10146 rather than guessed at here.
 *
 * ## State matrix — which of the 16 apply to this primitive
 * - **default** — every story below.
 * - **hover, focus-visible** — the trigger's reveal is CSS-only
 *   (`opacity-0` at rest, `group-hover/header:opacity-100`,
 *   `focus-visible:opacity-100`); jsdom has no CSS engine, so the assertions
 *   below pin the actual class STRINGS rather than a rendered opacity, per
 *   this repo's own lesson that `toBeVisible()` cannot catch a CSS-only
 *   regression.
 * - **selected** — not applicable. Row/cell selection is a `GridTableV2Cell`
 *   and body-row concern; this module renders no selection state.
 * - **editing** — not applicable. Cell-content editors are a separate layer
 *   composed inside the body cell, never inside the header.
 * - **dragging, drag-over** — not applicable to *this* module specifically:
 *   `draggable` here only toggles the label's `cursor-grab`/`cursor-grabbing`
 *   classes (see `DraggableLabel`), it does not itself initiate a drag. The
 *   actual reorder drag lives on the header CELL in
 *   `table-grid-header-v2-handles.tsx` / `table-grid-header-v2.tsx`, covered
 *   by `Table Grid Header V2 Handles`' `ColumnReorderDrop` story.
 * - **loading, empty, partial, error** — not applicable, matching the sibling
 *   header story's own reasoning: this renders identically regardless of the
 *   body's fetch state, because it owns none of that state.
 * - **disabled, read-only, permission** — not applicable. Neither component
 *   declares any such prop. A column that should offer no actions gets there
 *   by omission — no `actions` wired, and no `filterable`/`groupable`/
 *   `movable` flags set — not by a boolean this component reads (see
 *   `NoMenuWhenNothingWired`).
 * - **narrow** — demonstrated by the composed Grid Table Grouped Sections
 *   entry, where this header keeps only the canonical Name projection.
 * - **overflow** — the label WRAPS (`line-clamp-2 whitespace-normal`) rather
 *   than truncating with an overflow tooltip; that is a different visual
 *   contract than the body cell's truncate-and-tooltip, and is exercised
 *   here (`WrappingLabel`) rather than in the value-cell's `Overflow` story.
 *
 * ## Accessibility
 * `@storybook/addon-a11y` is not wired into this Storybook — the assertions
 * below are real DOM/attribute/class checks, not an automated axe scan.
 */
const meta = {
  title: "Composites v1.0/Data Display/Tables/Table Grid Header V2 Label",
  component: HeaderActionsMenu,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    columnId: { control: "text" },
    controlName: { control: "text" },
    label: { control: "text" },
    tooltip: { control: "text" },
    sortBy: { control: "text" },
    sortDir: { control: "select", options: ["asc", "desc"] },
    alignEnd: { control: "boolean" },
    draggable: { control: "boolean" },
    filterable: { control: "boolean" },
    groupable: { control: "boolean" },
    movable: { control: "boolean" },
    sortable: { control: "boolean" },
    // A capability-flag/callback bag, not a scalar — each story wires it
    // directly rather than through a generic control.
    actions: { table: { disable: true } },
    onSort: { table: { disable: true } },
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof HeaderActionsMenu>;

export default meta;

type Story = StoryObj<typeof meta>;

const COLUMN_ID = "owner";
const COLUMN_LABEL = "Owner";
const TRIGGER_NAME = `${COLUMN_LABEL} column options`;
const TOOLTIP_TEXT = "Help text";
const FILTER_CONTENT_TEXT = "Custom filter body";

/**
 * The full menu: sort rides along with filter (via `getFilterContent`, the
 * custom-body branch `ColumnOptionsMenu` does not have), group, and move.
 * Each action is asserted by CALLING it through the real menu item, not by
 * re-deriving what the click should do.
 */
export const FullMenu: Story = {
  render: (args) => {
    const [lastAction, setLastAction] = useState("none");
    return (
      <div className="flex flex-col gap-3">
        <HeaderCellHost>
          <HeaderActionsMenu
            actions={{
              getFilterContent: () => <div>{FILTER_CONTENT_TEXT}</div>,
              onGroup: (id) => setLastAction(`group ${id}`),
              onMove: (id, direction) =>
                setLastAction(`move ${id} ${direction}`),
            }}
            alignEnd={args.alignEnd}
            columnId={args.columnId ?? COLUMN_ID}
            controlName={args.controlName ?? COLUMN_LABEL}
            draggable={args.draggable}
            filterable={args.filterable ?? true}
            groupable={args.groupable ?? true}
            label={args.label ?? COLUMN_LABEL}
            movable={args.movable ?? true}
            onSort={(id, direction) => setLastAction(`sort ${id} ${direction}`)}
            sortable={args.sortable}
            sortBy={args.sortBy ?? null}
            sortDir={args.sortDir ?? "asc"}
            tooltip={args.tooltip}
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

    await userEvent.click(trigger);
    const body = within(globalThis.document.body);

    // Sort ascending fires with the real column id.
    await userEvent.click(
      await body.findByRole("menuitem", { name: "Sort ascending" })
    );
    await expect(canvas.getByText("sort owner asc")).toBeInTheDocument();

    // Filter opens the CUSTOM submenu body (`getFilterContent`), not a plain item.
    await userEvent.click(trigger);
    await userEvent.click(
      await body.findByRole("menuitem", { name: "Filter" })
    );
    await expect(
      await body.findByText(FILTER_CONTENT_TEXT)
    ).toBeInTheDocument();
    await userEvent.keyboard("{Escape}{Escape}");

    // Group fires with the real column id.
    await userEvent.click(trigger);
    await userEvent.click(await body.findByRole("menuitem", { name: "Group" }));
    await expect(canvas.getByText("group owner")).toBeInTheDocument();

    // Move submenu: each direction fires with the real column id + direction.
    await userEvent.click(trigger);
    await userEvent.click(
      await body.findByRole("menuitem", { name: "Move column" })
    );
    await userEvent.click(
      await body.findByRole("menuitem", { name: "Move to start" })
    );
    await expect(canvas.getByText("move owner start")).toBeInTheDocument();
  },
};

/**
 * `getFilterContent` absent but `onFilter` present: the plain-item branch,
 * not the submenu branch. `ColumnOptionsMenu`'s only branch, mirrored here so
 * both real call shapes this component supports are covered.
 */
export const PlainFilterItem: Story = {
  render: (args) => {
    const [lastAction, setLastAction] = useState("none");
    return (
      <HeaderCellHost>
        <HeaderActionsMenu
          actions={{ onFilter: (id) => setLastAction(`filter ${id}`) }}
          alignEnd={args.alignEnd}
          columnId={args.columnId ?? COLUMN_ID}
          controlName={args.controlName ?? COLUMN_LABEL}
          draggable={args.draggable}
          filterable={args.filterable ?? true}
          groupable={args.groupable}
          label={args.label ?? COLUMN_LABEL}
          movable={args.movable}
          onSort={() => setLastAction("sort")}
          sortable={args.sortable}
          sortBy={args.sortBy ?? null}
          sortDir={args.sortDir ?? "asc"}
          tooltip={args.tooltip}
        />
        <p className="text-muted-foreground text-xs">{lastAction}</p>
      </HeaderCellHost>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: TRIGGER_NAME }));
    const filterItem = await within(globalThis.document.body).findByRole(
      "menuitem",
      { name: "Filter" }
    );
    await userEvent.click(filterItem);
    await expect(canvas.getByText("filter owner")).toBeInTheDocument();
  },
};

/**
 * `groupable` true but the caller wired no `onGroup` — the review-flagged gate
 * (see the source's "whitlockk review" comment): `groupable` alone is a column
 * CAPABILITY, not proof the host wired grouping, so the item must not render
 * an affordance that silently does nothing when selected. Mirrors
 * `hasColumnMenuItems`'s equivalent gate on `ColumnOptionsMenu`'s sibling.
 */
export const CapabilityWithoutWiredAction: Story = {
  render: (args) => (
    <HeaderCellHost>
      <HeaderActionsMenu
        actions={{}}
        alignEnd={args.alignEnd}
        columnId={args.columnId ?? COLUMN_ID}
        controlName={args.controlName ?? COLUMN_LABEL}
        draggable={args.draggable}
        filterable={args.filterable}
        groupable={args.groupable ?? true}
        label={args.label ?? COLUMN_LABEL}
        movable={args.movable}
        onSort={() => undefined}
        sortable={args.sortable}
        sortBy={args.sortBy ?? null}
        sortDir={args.sortDir ?? "asc"}
        tooltip={args.tooltip}
      />
    </HeaderCellHost>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: TRIGGER_NAME }));
    const body = within(globalThis.document.body);
    await expect(await body.findByRole("menu")).toBeInTheDocument();
    await expect(body.queryByRole("menuitem", { name: "Group" })).toBeNull();
  },
};

/**
 * `alignEnd` (ISS-5333, numeric columns): the caret and options chevron LEAD
 * the label instead of trailing it, and the container justifies content to
 * the end rather than stretching the label with `flex-1`. Asserted on the
 * container's own class list — the ISS-5333 bug was exactly a class that
 * LOOKED present while the layout it implies did not hold.
 */
export const AlignEnd: Story = {
  args: {
    alignEnd: true,
    columnId: "amount",
    controlName: "Amount",
    label: "Amount",
    sortBy: "amount",
    sortDir: "desc",
  },
  render: (args) => (
    <HeaderCellHost>
      <HeaderActionsMenu
        actions={{}}
        alignEnd={args.alignEnd}
        columnId={args.columnId}
        controlName={args.controlName}
        draggable={args.draggable}
        filterable={args.filterable}
        groupable={args.groupable}
        label={args.label}
        movable={args.movable}
        onSort={() => undefined}
        sortable={args.sortable}
        sortBy={args.sortBy}
        sortDir={args.sortDir}
        tooltip={args.tooltip}
      />
    </HeaderCellHost>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = canvas.getByText("Amount");
    const container = label.parentElement;
    if (!container) {
      throw new Error("expected the header-actions container to render");
    }
    await expect(container.classList.contains("justify-end")).toBe(true);
    await expect(container.classList.contains("flex-1")).toBe(false);

    // Trigger leads: it comes BEFORE the label in DOM child order when
    // `alignEnd` — both are direct children of `container`, so their index in
    // its children list is the honest way to pin DOM order without reaching
    // for a bitwise `compareDocumentPosition` check.
    const trigger = canvas.getByRole("button", {
      name: "Amount column options",
    });
    const children = Array.from(container.children);
    await expect(children.indexOf(trigger)).toBeLessThan(
      children.indexOf(label)
    );
  },
};

/**
 * The sort indicator only appears once this column IS the active sort — it
 * is not a permanent affordance beside every sortable header.
 */
export const ActiveSortIndicator: Story = {
  args: {
    columnId: COLUMN_ID,
    controlName: COLUMN_LABEL,
    label: COLUMN_LABEL,
    // Equal to `columnId` by default so the indicator starts ACTIVE — change
    // either in Controls to see it disappear, which is the story's own point.
    sortBy: COLUMN_ID,
    sortDir: "desc",
  },
  render: (args) => (
    <HeaderCellHost>
      <HeaderActionsMenu
        actions={{}}
        alignEnd={args.alignEnd}
        columnId={args.columnId}
        controlName={args.controlName}
        draggable={args.draggable}
        filterable={args.filterable}
        groupable={args.groupable}
        label={args.label}
        movable={args.movable}
        onSort={() => undefined}
        sortable={args.sortable}
        sortBy={args.sortBy}
        sortDir={args.sortDir}
        tooltip={args.tooltip}
      />
    </HeaderCellHost>
  ),
  play: async ({ canvasElement }) => {
    // The indicator is an `aria-hidden` glyph beside the label, not itself an
    // accessible control. A bare `svg` query is not enough to prove this: the
    // menu trigger's own `ChevronDownIcon` is ALSO an svg and renders
    // unconditionally, so that query would pass even with no active sort.
    // `shrink-0` is the class `SortIndicator` alone receives (the trigger's
    // icon only carries `size-3.5`), so it is what actually pins the
    // indicator's conditional render.
    await expect(canvasElement.querySelector("svg.shrink-0")).not.toBeNull();
  },
};

/**
 * The trigger's reveal/focus/open classes, pinned directly — the CSS engine
 * jsdom lacks cannot prove `group-hover/header:opacity-100` applies at
 * runtime, but the class strings themselves are the contract this test can
 * hold, and a regression that silently drops one of them (as happened to the
 * sibling `ColumnOptionsMenu` trigger's ring, per the duplicate-implementation
 * note above) is exactly what this pins.
 */
export const TriggerRevealClasses: Story = {
  args: {
    columnId: COLUMN_ID,
    controlName: COLUMN_LABEL,
    label: COLUMN_LABEL,
    sortBy: null,
    sortDir: "asc",
  },
  render: (args) => (
    <HeaderCellHost>
      <HeaderActionsMenu
        actions={{}}
        alignEnd={args.alignEnd}
        columnId={args.columnId}
        controlName={args.controlName}
        draggable={args.draggable}
        filterable={args.filterable}
        groupable={args.groupable}
        label={args.label}
        movable={args.movable}
        onSort={() => undefined}
        sortable={args.sortable}
        sortBy={args.sortBy}
        sortDir={args.sortDir}
        tooltip={args.tooltip}
      />
    </HeaderCellHost>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: TRIGGER_NAME });
    const classes = trigger.classList;

    // The absent half of `ActiveSortIndicator`'s assertion, which that story
    // cannot pin from inside itself: this story renders with `sortBy: null`,
    // so the indicator must NOT be here. Same `svg.shrink-0` locator the
    // positive case uses — dropping the `sortBy === columnId ?` guard in
    // `table-grid-header-v2-label.tsx` reddens this line.
    await expect(canvasElement.querySelector("svg.shrink-0")).toBeNull();

    await expect(classes.contains("opacity-0")).toBe(true);
    await expect(classes.contains("group-hover/header:opacity-100")).toBe(true);
    await expect(classes.contains("focus-visible:opacity-100")).toBe(true);
    await expect(classes.contains("data-[state=open]:opacity-100")).toBe(true);

    // Radix stamps `data-state="open"` on the trigger while the menu is open —
    // the mechanism `data-[state=open]:opacity-100` depends on.
    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute("data-state", "open");
  },
};

/**
 * A label long enough to wrap. `line-clamp-2 whitespace-normal` — this
 * primitive WRAPS rather than truncating-with-tooltip, a different contract
 * than the value cell's `Overflow` story.
 */
const WRAPPING_LABEL = "Reconciliation disposition and column ownership";

export const WrappingLabel: Story = {
  render: (args) => (
    <div className="w-40">
      <HeaderLabel
        alignEnd={args.alignEnd}
        draggable={args.draggable}
        label={args.label ?? WRAPPING_LABEL}
        tooltip={args.tooltip}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = canvas.getByText(WRAPPING_LABEL);
    await expect(label.classList.contains("line-clamp-2")).toBe(true);
    await expect(label.classList.contains("whitespace-normal")).toBe(true);
  },
};

/**
 * `draggable` only ever changes the LABEL's cursor affordance here — the
 * actual drag is wired on the header cell, not this component. `cursor-grab`
 * at rest, `active:cursor-grabbing` while pressed.
 */
export const DraggableLabelCursor: Story = {
  args: { draggable: true, label: COLUMN_LABEL },
  render: (args) => (
    <HeaderLabel
      alignEnd={args.alignEnd}
      draggable={args.draggable}
      label={args.label ?? COLUMN_LABEL}
      tooltip={args.tooltip}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = canvas.getByText(COLUMN_LABEL);
    await expect(label.classList.contains("cursor-grab")).toBe(true);
    await expect(label.classList.contains("active:cursor-grabbing")).toBe(true);
  },
};

/**
 * A tooltip label wraps its text in a `Tooltip`/`TooltipTrigger` pair and
 * gains `cursor-pointer`; a label with none renders the plain span.
 *
 * The class alone is not the contract — `HeaderLabel` can keep
 * `cursor-pointer` while its `Tooltip`/`TooltipTrigger`/`TooltipContent`
 * wiring breaks, and a class-only assertion would stay green through that.
 * So this drives the real hover and reads the portaled popover, following
 * `Primitives/Overlays/Grid Table V2 Tooltip`'s pattern: the popover
 * is absent at rest, opens on hover carrying the tooltip text, and closes
 * again on unhover.
 */
export const LabelWithTooltip: Story = {
  args: { label: COLUMN_LABEL, tooltip: TOOLTIP_TEXT },
  render: (args) => (
    <HeaderLabel
      alignEnd={args.alignEnd}
      draggable={args.draggable}
      label={args.label ?? COLUMN_LABEL}
      tooltip={args.tooltip}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = canvas.getByText(COLUMN_LABEL);
    await expect(label.classList.contains("cursor-pointer")).toBe(true);

    // Closed at rest. This is the positive control's negative half: the same
    // locator resolves to a real node three lines down, so a `toBeNull()`
    // that can never fail is not what is being asserted here.
    await expect(openTooltip(canvasElement)).toBeNull();

    await userEvent.hover(label);
    await waitFor(() => {
      expect(openTooltip(canvasElement)).toHaveTextContent(TOOLTIP_TEXT);
    });

    // Dismiss: Radix unmounts the content on Escape.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(openTooltip(canvasElement)).toBeNull();
    });
  },
};

function HeaderCellHost({ children }: { children: ReactNode }) {
  return (
    <div className="group/header flex h-10 w-64 items-center rounded-sm border px-3 transition-colors duration-100 hover:bg-muted/40">
      {children}
    </div>
  );
}

/** The portaled Radix popover, which renders outside `canvasElement`. */
function openTooltip(canvasElement: HTMLElement): HTMLElement | null {
  return canvasElement.ownerDocument.querySelector<HTMLElement>(
    '[data-slot="tooltip-content"]'
  );
}
