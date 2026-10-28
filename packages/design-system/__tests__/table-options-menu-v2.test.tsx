import { DropdownMenuItem } from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import { TableOptionsMenu } from "@closedloop-ai/design-system/components/ui/table-options-menu-v2";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * ISS-5316. `TableOptionsMenu` is the WIDE half of a pair — below `md`,
 * `GridTableToolbar` hides it and shows `TableCompactViewMenu` instead. So a
 * capability either menu offers alone is a capability that appears or vanishes
 * as the window crosses that breakpoint, which reads as the product losing a
 * feature rather than as a smaller layout.
 *
 * `onAddField` was the half that only existed on the narrow menu (codex review),
 * so these pin it on this one, each against the omitted branch: an assertion
 * that only proved "the item can render" would stay green for a menu that
 * rendered it for a table whose columns are fixed.
 */

const ADD_FIELD_NAME = "Add field";
const EXPORT_NAME = "Export CSV";

const COLUMNS = [
  { key: "name", label: "Name" },
  { key: "owner", label: "Owner" },
];

function renderMenu(
  overrides: Partial<React.ComponentProps<typeof TableOptionsMenu>> = {}
) {
  const props: React.ComponentProps<typeof TableOptionsMenu> = {
    columns: COLUMNS,
    onToggleColumn: vi.fn(),
    visibleColumnIds: new Set(["name"]),
    ...overrides,
  };
  render(<TableOptionsMenu {...props} />);
  fireEvent.pointerDown(screen.getByRole("button", { name: "Options" }), {
    button: 0,
    ctrlKey: false,
  });
  return props;
}

describe("TableOptionsMenu add-field item", () => {
  it("offers the add-field item when the caller supports custom columns", () => {
    const onAddField = vi.fn();
    renderMenu({ onAddField });

    fireEvent.click(screen.getByRole("menuitem", { name: ADD_FIELD_NAME }));

    expect(onAddField).toHaveBeenCalledTimes(1);
  });

  it("omits the add-field item for a table with fixed columns", () => {
    renderMenu();

    expect(screen.queryByRole("menuitem", { name: ADD_FIELD_NAME })).toBeNull();
  });

  it("keeps the trailing slot alongside the add-field item", () => {
    // The two occupy the same region of the menu; the surface passes BOTH (the
    // export row and the add-field flow), so one must not displace the other.
    renderMenu({
      onAddField: vi.fn(),
      trailing: <DropdownMenuItem>{EXPORT_NAME}</DropdownMenuItem>,
    });

    expect(
      screen.getByRole("menuitem", { name: ADD_FIELD_NAME })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: EXPORT_NAME })
    ).toBeInTheDocument();
  });
});

describe("TableOptionsMenu viewport bounds", () => {
  it("keeps the menu scrollable inside the Radix available viewport", () => {
    renderMenu();

    const menu = screen.getByRole("menu");

    expect(menu.className).toContain(
      "max-h-[min(var(--radix-dropdown-menu-content-available-height),60vh,620px)]"
    );
    expect(menu.className).toContain("overflow-y-auto");
  });
});
