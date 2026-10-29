import { TableGroupMenu } from "@closedloop-ai/design-system/components/ui/table-group-menu-v2";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
  TableGroupOrder,
} from "@closedloop-ai/design-system/components/ui/table-toolbar-model";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * ISS-9676. `allowEmptyGroups` is how a surface whose grouping dimensions are
 * cut FROM the rows being banded declines an action it can never honour: with
 * no band outside those rows, "Show empty groups" would flip a checked state
 * the table cannot answer.
 *
 * Both directions are asserted here rather than only the opt-out, because the
 * DEFAULT is what Sessions renders — flipping it would strip the action from a
 * surface that never asked, with nothing else red.
 */

const GROUP_OPTIONS = [
  { id: "status", label: "Status" },
  { id: "owner", label: "Owner" },
];

const GROUPED: TableGroupingState = {
  primary: {
    fieldId: "status",
    order: TableGroupOrder.Ascending,
    showEmptyGroups: false,
  },
  secondary: EMPTY_TABLE_GROUPING.secondary,
};

// Radix reads the pointer-capture API jsdom does not implement.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const OPTIONS_LABEL = "Primary group options";
const SHOW_EMPTY_LABEL = "Show empty groups";
const RE_GROUPED_TRIGGER = /^Groups: 1/;

describe("TableGroupMenu empty-group action", () => {
  it("offers it by default, and toggles the level it belongs to", async () => {
    const onGroupingChange = vi.fn();
    renderMenu({ onGroupingChange });

    // Radix opens a dropdown on pointerdown, not on the synthesized click.
    fireEvent.pointerDown(screen.getByRole("button", { name: OPTIONS_LABEL }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: SHOW_EMPTY_LABEL })
    );

    expect(onGroupingChange).toHaveBeenCalledWith({
      ...GROUPED,
      primary: { ...GROUPED.primary, showEmptyGroups: true },
    });
  });

  it("withholds it when the caller opts out, keeping the rest of the level", () => {
    renderMenu({ allowEmptyGroups: false });

    // The level editor still renders in full — so the absence below is the
    // opt-out and not a popover that failed to open.
    expect(
      screen.getByRole("combobox", { name: "Primary grouping field" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Primary group order" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: OPTIONS_LABEL })).toBe(null);
  });
});

function renderMenu({
  allowEmptyGroups,
  onGroupingChange = () => undefined,
}: {
  allowEmptyGroups?: boolean;
  onGroupingChange?: (next: TableGroupingState) => void;
}) {
  const result = render(
    <TableGroupMenu
      allowEmptyGroups={allowEmptyGroups}
      grouping={GROUPED}
      onGroupingChange={onGroupingChange}
      options={GROUP_OPTIONS}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: RE_GROUPED_TRIGGER }));
  return result;
}
