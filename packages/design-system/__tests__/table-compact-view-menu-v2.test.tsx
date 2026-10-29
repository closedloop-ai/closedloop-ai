import { DropdownMenuItem } from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import { TableCompactViewMenu } from "@closedloop-ai/design-system/components/ui/table-compact-view-menu-v2";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
  TableGroupOrder,
} from "@closedloop-ai/design-system/components/ui/table-toolbar-model";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const FIELD_PATTERN = /field/i;
const ADD_PATTERN = /Add/;
const THEN_GROUP_BY_PATTERN = /Then group by/;
const GROUP_BY_PATTERN = /Group by/;
const ADD_SECOND_GROUP_PATTERN = /Add second group/;
const STATUS_PATTERN = /Status/;
const EXPORT_LABEL = "Export CSV";

/**
 * ISS-7349. The compact View menu is the narrow-layout stand-in for four
 * separate wide-layout controls, so it is the one place a phone user can read
 * and change the table's arrangement. Two things it must get right and no
 * story can check, because both live behind an opened menu:
 *
 *  - the "Then group by" row is PRESENT BUT DISABLED when nothing is grouped —
 *    a row that appears only once something else is set reads as the menu
 *    changing shape under the user;
 *  - choosing a secondary field that the primary level already uses must not be
 *    offered, and choosing the primary's field for the primary level must drop
 *    the secondary, or the table groups twice by one column and paints one row
 *    per group.
 */

const GROUP_OPTIONS = [
  { id: "status", label: "Status" },
  { id: "owner", label: "Owner" },
];

const SORT_OPTIONS = [
  { id: "name", label: "Name" },
  { id: "updated", label: "Updated" },
];

const COLUMNS = [
  { key: "name", label: "Name" },
  { key: "owner", label: "Owner" },
];

const GROUPED_BY_STATUS: TableGroupingState = {
  primary: {
    fieldId: "status",
    order: TableGroupOrder.Custom,
    showEmptyGroups: false,
  },
  secondary: EMPTY_TABLE_GROUPING.secondary,
};

function renderMenu(
  overrides: Partial<React.ComponentProps<typeof TableCompactViewMenu>> = {}
) {
  const props: React.ComponentProps<typeof TableCompactViewMenu> = {
    columns: COLUMNS,
    grouping: EMPTY_TABLE_GROUPING,
    groupOptions: GROUP_OPTIONS,
    onClearSort: vi.fn(),
    onGroupingChange: vi.fn(),
    onSort: vi.fn(),
    onToggleColumn: vi.fn(),
    sortBy: null,
    sortOptions: SORT_OPTIONS,
    visibleColumnIds: new Set(["name"]),
    ...overrides,
  };
  render(<TableCompactViewMenu {...props} />);
  fireEvent.pointerDown(screen.getByRole("button", { name: "View" }), {
    button: 0,
    ctrlKey: false,
  });
  return props;
}

const openSubmenu = (name: string | RegExp) =>
  fireEvent.keyDown(screen.getByRole("menuitem", { name }), {
    key: "ArrowRight",
  });

/**
 * The switch inside a `TableOptionsSwitchRow` is decorative — the menu item owns
 * the hit area and the accessible name — so a row is addressed by its label and
 * its state read off the nested switch.
 */
const switchRow = (label: string) =>
  screen.getByRole("menuitem", { name: label });

const isRowChecked = (label: string) =>
  within(switchRow(label)).getByRole("switch").getAttribute("data-state") ===
  "checked";

describe("TableCompactViewMenu sort section", () => {
  it("checks None when nothing is sorted", () => {
    renderMenu();

    expect(screen.getByRole("menuitemradio", { name: "None" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
  });

  it("checks the active sort field", () => {
    renderMenu({ sortBy: "updated" });

    expect(
      screen.getByRole("menuitemradio", { name: "Updated" })
    ).toHaveAttribute("aria-checked", "true");
  });

  it("raises a sort intent with the chosen field", () => {
    const props = renderMenu();

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Name" }));

    expect(props.onSort).toHaveBeenCalledWith("name");
  });

  it("raises a CLEAR intent rather than sorting by a field named 'none'", () => {
    // The radio group needs a string for the empty state; it must not reach the
    // sort handler as a field id.
    const props = renderMenu({ sortBy: "name" });

    fireEvent.click(screen.getByRole("menuitemradio", { name: "None" }));

    expect(props.onClearSort).toHaveBeenCalledTimes(1);
    expect(props.onSort).not.toHaveBeenCalled();
  });

  it("adds a secondary ordered sort in compact mode", () => {
    const onSortsChange = vi.fn();
    renderMenu({
      onSortsChange,
      sorts: [{ fieldId: "name", direction: "asc" }],
    });

    openSubmenu("Add sort");
    fireEvent.click(screen.getByRole("menuitem", { name: "Updated" }));

    expect(onSortsChange).toHaveBeenCalledWith([
      { fieldId: "name", direction: "asc" },
      { fieldId: "updated", direction: "asc" },
    ]);
  });
});

describe("TableCompactViewMenu grouping section", () => {
  it("keeps sorting while omitting unsupported grouping", () => {
    renderMenu({
      grouping: undefined,
      groupOptions: undefined,
      onGroupingChange: undefined,
    });

    expect(screen.getByText("Sort by")).toBeInTheDocument();
    expect(screen.queryByText("Grouping")).toBeNull();
  });

  it("reads 'None' on the group-by trigger when nothing is grouped", () => {
    renderMenu();

    const trigger = screen.getByRole("menuitem", { name: GROUP_BY_PATTERN });

    expect(within(trigger).getByText("None")).toBeInTheDocument();
  });

  it("names the grouped field on the trigger so it is legible unopened", () => {
    renderMenu({ grouping: GROUPED_BY_STATUS });

    expect(
      screen.getByRole("menuitem", { name: STATUS_PATTERN })
    ).toBeInTheDocument();
  });

  it("shows a disabled second-group row when nothing is grouped", () => {
    // Present but disabled: a row that only appears later reads as the menu
    // changing shape.
    renderMenu();

    const addSecond = screen.getByRole("menuitem", {
      name: ADD_SECOND_GROUP_PATTERN,
    });

    expect(addSecond).toBeInTheDocument();
    expect(addSecond).toHaveAttribute("aria-disabled", "true");
  });

  it("replaces the disabled row with a real submenu once grouped", () => {
    renderMenu({ grouping: GROUPED_BY_STATUS });

    expect(
      screen.queryByRole("menuitem", { name: ADD_SECOND_GROUP_PATTERN })
    ).toBeNull();
    expect(
      screen.getByRole("menuitem", { name: THEN_GROUP_BY_PATTERN })
    ).toBeInTheDocument();
  });

  it("reads 'Add group' on the second-level trigger while it is unset", () => {
    renderMenu({ grouping: GROUPED_BY_STATUS });

    expect(screen.getByText("Add group")).toBeInTheDocument();
  });

  it("raises a grouping change for the chosen primary field", () => {
    const props = renderMenu();
    openSubmenu(GROUP_BY_PATTERN);

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Owner" }));

    expect(props.onGroupingChange).toHaveBeenCalledWith(
      expect.objectContaining({
        primary: expect.objectContaining({ fieldId: "owner" }),
      })
    );
  });

  it("clears the whole grouping when the primary is set to None", () => {
    const props = renderMenu({ grouping: GROUPED_BY_STATUS });
    openSubmenu(GROUP_BY_PATTERN);

    // Two "None" radios are mounted at once — the sort group's and the
    // grouping submenu's. The last one is the submenu that just opened.
    const noneItems = screen.getAllByRole("menuitemradio", { name: "None" });
    fireEvent.click(noneItems.at(-1) as HTMLElement);

    expect(props.onGroupingChange).toHaveBeenCalledWith(EMPTY_TABLE_GROUPING);
  });

  it("omits the primary's field from the secondary options", () => {
    // Grouping twice by one column paints one row per group.
    renderMenu({ grouping: GROUPED_BY_STATUS });
    openSubmenu(THEN_GROUP_BY_PATTERN);

    expect(screen.queryByRole("menuitemradio", { name: "Status" })).toBeNull();
    expect(
      screen.getByRole("menuitemradio", { name: "Owner" })
    ).toBeInTheDocument();
  });

  it("raises a grouping change for the chosen secondary field", () => {
    const props = renderMenu({ grouping: GROUPED_BY_STATUS });
    openSubmenu(THEN_GROUP_BY_PATTERN);

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Owner" }));

    expect(props.onGroupingChange).toHaveBeenCalledWith(
      expect.objectContaining({
        primary: GROUPED_BY_STATUS.primary,
        secondary: expect.objectContaining({ fieldId: "owner" }),
      })
    );
  });
});

/**
 * ISS-7120 review follow-up. `DropdownMenuSubContent` ignores a focus-outside
 * that lands on a `role=menu` container, because Radix only ever puts focus
 * there by bouncing it off an item — never because a person aimed at it. Radix
 * bounces it for two different reasons, and the guard cannot tell them apart:
 * the menu sliding out from under a stationary cursor (the bug), and the pointer
 * genuinely arriving on a DISABLED item, whose `onPointerMove` calls the same
 * `onItemLeave`. This menu is where the second one is reachable — "Add second
 * group" is disabled exactly while the "Group by" submenu above it is openable —
 * so the behaviour change is pinned here rather than left to be discovered.
 *
 * Hovering a dead control no longer dismisses the submenu the person is aiming
 * at. Every other dismissal is untouched, and the two below say so.
 */
describe("TableCompactViewMenu submenu dismissal", () => {
  it("keeps the group-by submenu open when the pointer reaches the disabled second-group row", () => {
    renderMenu();
    openSubmenu(GROUP_BY_PATTERN);
    const submenuRow = screen.getByRole("menuitemradio", { name: "Owner" });

    fireEvent.pointerMove(
      screen.getByRole("menuitem", { name: ADD_SECOND_GROUP_PATTERN }),
      { pointerType: "mouse" }
    );

    expect(submenuRow.isConnected).toBe(true);
  });

  // The other half, so the guard above cannot widen into "a submenu never
  // closes": an ENABLED row takes focus itself, which is a menu item and not the
  // container, and still closes the submenu that was open.
  it("still closes the group-by submenu when the pointer reaches an enabled row", () => {
    renderMenu();
    openSubmenu(GROUP_BY_PATTERN);
    const submenuRow = screen.getByRole("menuitemradio", { name: "Owner" });

    fireEvent.pointerMove(switchRow("Name"), { pointerType: "mouse" });

    expect(submenuRow.isConnected).toBe(false);
  });

  it("still closes the group-by submenu on Escape", () => {
    renderMenu();
    openSubmenu(GROUP_BY_PATTERN);
    const submenuRow = screen.getByRole("menuitemradio", { name: "Owner" });

    fireEvent.keyDown(screen.getAllByRole("menu").at(-1) as HTMLElement, {
      key: "Escape",
    });

    expect(submenuRow.isConnected).toBe(false);
  });
});

describe("TableCompactViewMenu column and metric rows", () => {
  it("renders one switch row per column, checked by visibility", () => {
    renderMenu();

    expect(isRowChecked("Name")).toBe(true);
    expect(isRowChecked("Owner")).toBe(false);
  });

  it("raises a toggle intent carrying the column key", () => {
    const props = renderMenu();

    fireEvent.click(switchRow("Owner"));

    expect(props.onToggleColumn).toHaveBeenCalledWith("owner");
  });

  it("omits the summary-cards section when the table has no metrics", () => {
    renderMenu();

    expect(screen.queryByText("Summary cards")).toBeNull();
  });

  it("omits the summary-cards section for an empty metric list", () => {
    renderMenu({ metrics: [] });

    expect(screen.queryByText("Summary cards")).toBeNull();
  });

  it("renders metric rows when the table has metrics", () => {
    renderMenu({
      metrics: [{ key: "cost", label: "Cost" }],
      visibleMetricKeys: new Set(["cost"]),
    });

    expect(screen.getByText("Summary cards")).toBeInTheDocument();
    expect(isRowChecked("Cost")).toBe(true);
  });

  it("renders an unchecked metric row when no visible set is supplied", () => {
    renderMenu({ metrics: [{ key: "cost", label: "Cost" }] });

    expect(isRowChecked("Cost")).toBe(false);
  });

  it("raises a metric toggle intent carrying the metric key", () => {
    const onToggleMetric = vi.fn();
    renderMenu({
      metrics: [{ key: "cost", label: "Cost" }],
      onToggleMetric,
      visibleMetricKeys: new Set<string>(),
    });

    fireEvent.click(switchRow("Cost"));

    expect(onToggleMetric).toHaveBeenCalledWith("cost");
  });

  it("omits the add-field item for a table with fixed columns", () => {
    renderMenu();

    expect(
      screen.queryByRole("menuitem", { name: ADD_PATTERN })
    ).not.toHaveAttribute("aria-disabled", "false");
  });

  it("offers the add-field item when the caller supports it", () => {
    const onAddField = vi.fn();
    renderMenu({ onAddField });

    fireEvent.click(screen.getByRole("menuitem", { name: FIELD_PATTERN }));

    expect(onAddField).toHaveBeenCalledTimes(1);
  });
});

/**
 * ISS-5316. This menu REPLACES `TableOptionsMenu` below `md` rather than sitting
 * beside it, so an action a surface appends to that menu's `trailing` slot — the
 * CSV export row — is unreachable on a phone unless this menu takes the same
 * slot (codex review). The omitted branch is the sibling: a surface with nothing
 * to append must not grow an empty region.
 */
describe("TableCompactViewMenu trailing slot", () => {
  it("renders the appended items a surface supplies", () => {
    renderMenu({
      trailing: <DropdownMenuItem>{EXPORT_LABEL}</DropdownMenuItem>,
    });

    expect(
      screen.getByRole("menuitem", { name: EXPORT_LABEL })
    ).toBeInTheDocument();
  });

  it("appends nothing when the surface has no trailing items", () => {
    renderMenu();

    expect(screen.queryByRole("menuitem", { name: EXPORT_LABEL })).toBeNull();
  });
});

describe("TableCompactViewMenu viewport bounds", () => {
  it("keeps the menu scrollable inside the Radix available viewport", () => {
    renderMenu();

    const menu = screen.getByRole("menu");

    expect(menu.className).toContain(
      "max-h-[min(var(--radix-dropdown-menu-content-available-height),75vh,40rem)]"
    );
    expect(menu.className).toContain("overflow-y-auto");
  });
});
