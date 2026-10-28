import {
  DropdownMenu,
  DropdownMenuContent,
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import { FilterGroupContent } from "@closedloop-ai/design-system/components/ui/filter-popover";
import type { FilterMenuGroup } from "@closedloop-ai/design-system/components/ui/table-filters";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * `FilterGroupContent` is the adapter a column header menu reaches for when the
 * grid already owns the submenu shell. It has exactly one job — delegate to the
 * options or range controls for the group it is handed — so both kinds are
 * driven through the export itself and the host's own callbacks are asserted to
 * receive the interaction.
 */
function renderInMenu(children: ReactNode) {
  return render(
    <DropdownMenu open>
      <DropdownMenuContent>{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

const OPTION_GROUP_ID = "status";
const RANGE_GROUP_ID = "cost";

describe("FilterGroupContent", () => {
  it("delegates an options group to the option controls and reports the toggle", () => {
    const onToggle = vi.fn();
    const group: FilterMenuGroup = {
      id: OPTION_GROUP_ID,
      kind: "options",
      label: "Status",
      options: [
        { id: "active", label: "Active" },
        { id: "blocked", label: "Blocked" },
      ],
      selectedValues: [],
      onToggle,
    };

    renderInMenu(<FilterGroupContent group={group} />);
    fireEvent.click(screen.getByText("Blocked"));

    expect(onToggle).toHaveBeenCalledWith("blocked");
  });

  it("delegates a range group to the range controls and commits both bounds", () => {
    const onChange = vi.fn();
    const group: FilterMenuGroup = {
      id: RANGE_GROUP_ID,
      kind: "range",
      label: "Cost",
      min: undefined,
      max: undefined,
      onChange,
    };

    renderInMenu(<FilterGroupContent group={group} />);
    const min = screen.getByLabelText("Min");
    const max = screen.getByLabelText("Max");

    fireEvent.change(min, { target: { value: "5" } });
    fireEvent.change(max, { target: { value: "50" } });
    fireEvent.blur(max);

    expect(onChange).toHaveBeenLastCalledWith({ min: 5, max: 50 });
  });
  it("reports search changes to a remote facet host while retaining its selected options", () => {
    const onSearchChange = vi.fn();
    const group: FilterMenuGroup = {
      id: "sessions",
      label: "Related Sessions",
      options: [{ id: "session", label: "Earlier session" }],
      selectedValues: ["session"],
      onToggle: vi.fn(),
      onSearchChange,
    };
    renderInMenu(<FilterGroupContent group={group} />);
    fireEvent.change(screen.getByPlaceholderText("Filter..."), {
      target: { value: "Later session" },
    });
    expect(onSearchChange).toHaveBeenCalledWith("Later session");
  });
});
