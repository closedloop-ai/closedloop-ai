import { TableSavedViewsMenu } from "@closedloop-ai/design-system/components/ui/table-saved-views-menu-v2";
import {
  type TableSavedView,
  TableSavedViewScope,
} from "@closedloop-ai/design-system/components/ui/table-toolbar-model";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-10309. `TableSavedViewsMenu` (the v2 apply-or-save menu) is mounted
 * closed by the grid-table-toolbar story, which checks its trigger and nothing
 * else. It owns three decisions: what the closed trigger claims, which scope
 * sections the open menu lists, and the save dialog's blank-name gate and
 * reset. The last two sit behind states no story opens.
 */

const VIEWS: TableSavedView[] = [
  { id: "mine", name: "My rows", scope: TableSavedViewScope.Personal },
  { id: "team", name: "Team rows", scope: TableSavedViewScope.Team },
  { id: "proj", name: "Project rows", scope: TableSavedViewScope.Project },
];

afterEach(cleanup);

function renderMenu(
  overrides: Partial<React.ComponentProps<typeof TableSavedViewsMenu>> = {}
) {
  const props = {
    activeViewId: null as string | null,
    onApply: vi.fn(),
    onSave: vi.fn(),
    views: VIEWS,
    ...overrides,
  };
  render(<TableSavedViewsMenu {...props} />);
  return props;
}

/** Radix opens on pointerdown, not click. */
function openMenu(triggerName: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: triggerName }), {
    button: 0,
    ctrlKey: false,
  });
  return screen.getByRole("menu");
}

function openSaveDialog(triggerName = "Views") {
  const menu = openMenu(triggerName);
  fireEvent.click(
    within(menu).getByRole("menuitem", { name: "Save current view" })
  );
  return screen.getByRole("dialog");
}

describe("TableSavedViewsMenu trigger", () => {
  it("says Views when no view is applied", () => {
    renderMenu();

    expect(screen.getByRole("button", { name: "Views" })).toBeInTheDocument();
  });

  it("names the applied view", () => {
    renderMenu({ activeViewId: "team" });

    expect(
      screen.getByRole("button", { name: "Team rows" })
    ).toBeInTheDocument();
  });

  it("falls back to Views when the active id names no view", () => {
    renderMenu({ activeViewId: "ghost" });

    expect(screen.getByRole("button", { name: "Views" })).toBeInTheDocument();
  });
});

describe("TableSavedViewsMenu open menu", () => {
  it("lists the scope sections in personal, team, project order", () => {
    renderMenu();
    const menu = openMenu("Views");

    const labels = ["Personal views", "Team views", "Project views"].map(
      (label) => within(menu).getByText(label)
    );
    expect(labels[0].compareDocumentPosition(labels[1])).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(labels[1].compareDocumentPosition(labels[2])).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    // Two between the three sections, one above the save item.
    expect(within(menu).getAllByRole("separator")).toHaveLength(3);
  });

  it("renders nothing for a scope with no views", () => {
    renderMenu({ views: [VIEWS[0]] });
    const menu = openMenu("Views");

    expect(within(menu).getByText("Personal views")).toBeInTheDocument();
    expect(within(menu).queryByText("Team views")).toBeNull();
    expect(within(menu).queryByText("Project views")).toBeNull();
    // Only the separator above the save item.
    expect(within(menu).getAllByRole("separator")).toHaveLength(1);
  });

  it("still draws a leading separator when the first listed section is not personal", () => {
    // Pins current behavior; looks odd because the separator keys off the
    // section's fixed index, not its rendered position, so a menu whose first
    // visible section is Team opens with a divider above its first heading.
    renderMenu({ views: [VIEWS[1]] });
    const menu = openMenu("Views");

    const [first] = within(menu).getAllByRole("separator");
    expect(
      first.compareDocumentPosition(within(menu).getByText("Team views"))
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);
  });

  it("shows the check only on the applied view", () => {
    renderMenu({ activeViewId: "team" });
    const menu = openMenu("Team rows");

    const checkOf = (name: string) =>
      within(menu)
        .getByRole("menuitem", { name })
        .querySelector("svg") as SVGElement;
    expect(checkOf("Team rows")).toHaveClass("opacity-100");
    expect(checkOf("My rows")).toHaveClass("opacity-0");
    expect(checkOf("Project rows")).toHaveClass("opacity-0");
  });

  it("applies the selected view by id", () => {
    const props = renderMenu();
    const menu = openMenu("Views");

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Team rows" }));

    expect(props.onApply).toHaveBeenCalledExactlyOnceWith("team");
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it.each([
    ["end", undefined],
    ["start", "start" as const],
  ])("aligns the menu content to %s", (expected, align) => {
    renderMenu({ align });
    const menu = openMenu("Views");

    expect(menu).toHaveAttribute("data-align", expected);
  });
});

describe("TableSavedViewsMenu save dialog", () => {
  it("keeps Save disabled until the name has non-blank text", () => {
    renderMenu();
    const dialog = openSaveDialog();
    const save = within(dialog).getByRole("button", { name: "Save view" });

    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("View name"), {
      target: { value: "   " },
    });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("View name"), {
      target: { value: "x" },
    });
    expect(save).toBeEnabled();
  });

  it("saves the trimmed name and closes", () => {
    const props = renderMenu();
    const dialog = openSaveDialog();

    fireEvent.change(within(dialog).getByLabelText("View name"), {
      target: { value: "  Triage  " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save view" }));

    expect(props.onSave).toHaveBeenCalledExactlyOnceWith("Triage");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clears the typed name when cancelled, so a reopen starts empty", () => {
    const props = renderMenu();
    let dialog = openSaveDialog();
    fireEvent.change(within(dialog).getByLabelText("View name"), {
      target: { value: "Draft" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(props.onSave).not.toHaveBeenCalled();
    dialog = openSaveDialog();
    expect(within(dialog).getByLabelText("View name")).toHaveValue("");
  });

  it("clears the typed name when dismissed with Escape", () => {
    renderMenu();
    let dialog = openSaveDialog();
    fireEvent.change(within(dialog).getByLabelText("View name"), {
      target: { value: "Draft" },
    });

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    dialog = openSaveDialog();
    expect(within(dialog).getByLabelText("View name")).toHaveValue("");
  });
});
