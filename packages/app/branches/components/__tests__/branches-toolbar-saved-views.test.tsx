import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BRANCH_FILTERS } from "../../lib/branch-row";
import {
  BranchesToolbar,
  type BranchesToolbarSavedViews,
} from "../branches-toolbar";

const UPDATE_ITEM_NAME = /Update .*My open branches/;
const ANY_UPDATE_ITEM = /Update /;

function makeSavedViews(
  overrides: Partial<BranchesToolbarSavedViews> = {}
): BranchesToolbarSavedViews {
  return {
    views: [{ id: "v1", name: "My open branches" }],
    activeViewId: null,
    modified: false,
    onSelectView: vi.fn(),
    onCreateView: vi.fn(),
    onUpdateView: vi.fn(),
    onRenameView: vi.fn(),
    onDeleteView: vi.fn(),
    ...overrides,
  };
}

// Radix DropdownMenu opens on pointer/keyboard, not a bare click in jsdom.
// Open it via the keyboard (focus + Enter), matching how a keyboard user does.
function openSwitcher() {
  const trigger = screen.getByRole("button", { name: "Branch views" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
}

function openRowActions() {
  const kebab = screen.getByRole("button", {
    name: "Actions for My open branches",
  });
  kebab.focus();
  fireEvent.keyDown(kebab, { key: "Enter", code: "Enter" });
}

function renderToolbar(
  savedViews?: BranchesToolbarSavedViews,
  options: { approved?: boolean; onResetView?: () => void } = {}
) {
  return render(
    <BranchesToolbar
      approved={options.approved}
      dateRange="7d"
      filters={DEFAULT_BRANCH_FILTERS}
      onDateRangeChange={vi.fn()}
      onFiltersChange={vi.fn()}
      onResetView={options.onResetView}
      onToggleColumn={vi.fn()}
      rows={[]}
      savedViews={savedViews}
      visibleColumns={new Set()}
    />
  );
}

describe("BranchesToolbar saved views adoption (FEA-4180)", () => {
  it("renders no switcher when savedViews is omitted", () => {
    renderToolbar();
    expect(
      screen.queryByRole("button", { name: "Branch views" })
    ).not.toBeInTheDocument();
  });

  it("leads the trigger with the view concept and the active view name", () => {
    renderToolbar(makeSavedViews({ activeViewId: "v1" }));
    const trigger = screen.getByRole("button", { name: "Branch views" });
    // "Views: <name>" so it reads as the view identity, not another filter chip.
    expect(trigger).toHaveTextContent("Views: My open branches");
  });

  it("leads the trigger with the default view when none is active", () => {
    renderToolbar(makeSavedViews({ activeViewId: null }));
    const trigger = screen.getByRole("button", { name: "Branch views" });
    expect(trigger).toHaveTextContent("Views: Default view");
  });

  it('labels the columns menu "Columns", not "View", so it does not clash with the views switcher', () => {
    renderToolbar(makeSavedViews({ activeViewId: null }));
    expect(screen.getByRole("button", { name: "Columns" })).toBeInTheDocument();
    // The switcher owns the "view" concept; there is no second "View" button.
    expect(
      screen.queryByRole("button", { name: "View" })
    ).not.toBeInTheDocument();
  });

  it("labels the approved reset as column visibility, not view identity", () => {
    renderToolbar(undefined, { approved: true, onResetView: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));

    expect(
      screen.getByRole("button", { name: "Reset columns" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reset view" })
    ).not.toBeInTheDocument();
  });

  it("opens the create dialog and wires onCreateView", () => {
    const savedViews = makeSavedViews();
    renderToolbar(savedViews);

    openSwitcher();
    fireEvent.click(screen.getByText("Save as new view…"));

    const input = screen.getByLabelText("View name");
    fireEvent.change(input, { target: { value: "Awaiting review" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(savedViews.onCreateView).toHaveBeenCalledWith("Awaiting review");
  });

  it("switches views via the radio group", () => {
    const savedViews = makeSavedViews();
    renderToolbar(savedViews);

    openSwitcher();
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "My open branches" })
    );

    expect(savedViews.onSelectView).toHaveBeenCalledWith("v1");
  });

  it("confirms before deleting via the per-view kebab (destructive confirm)", () => {
    const savedViews = makeSavedViews();
    renderToolbar(savedViews);

    openSwitcher();
    openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    // The delete does not fire until the AlertDialog is confirmed.
    expect(savedViews.onDeleteView).not.toHaveBeenCalled();
    const confirm = screen.getByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));

    expect(savedViews.onDeleteView).toHaveBeenCalledWith("v1");
  });

  it("shows a Modified marker and an Update item only when the live table has diverged", () => {
    const savedViews = makeSavedViews({ activeViewId: "v1", modified: true });
    renderToolbar(savedViews);

    const trigger = screen.getByRole("button", { name: "Branch views" });
    expect(trigger).toHaveTextContent("Modified");

    openSwitcher();
    fireEvent.click(screen.getByRole("menuitem", { name: UPDATE_ITEM_NAME }));
    expect(savedViews.onUpdateView).toHaveBeenCalledWith("v1");
  });

  it("hides the Modified marker and Update item when the table matches the active view", () => {
    renderToolbar(makeSavedViews({ activeViewId: "v1", modified: false }));

    const trigger = screen.getByRole("button", { name: "Branch views" });
    expect(trigger).not.toHaveTextContent("Modified");

    openSwitcher();
    expect(
      screen.queryByRole("menuitem", { name: ANY_UPDATE_ITEM })
    ).not.toBeInTheDocument();
  });
});
