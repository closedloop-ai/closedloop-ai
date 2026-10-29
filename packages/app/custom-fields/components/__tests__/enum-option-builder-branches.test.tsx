/**
 * Branch coverage for EnumOptionBuilder (ISS-10515): create-mode local state
 * (seeding, rename commit/revert, colour, disable/enable, delete, drag guards)
 * and edit-mode row actions routed to the enum-option mutations.
 */

import type { DragEndEvent } from "@dnd-kit/core";
import type {
  CreateEnumOptionInput,
  CustomFieldEnumOption,
} from "@repo/api/src/types/custom-field";
import { CustomFieldOptionColor } from "@repo/app/custom-fields/lib/option-colors";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnumOptionBuilder } from "../enum-option-builder";

const FIELD_ID = "field-1";
const FIXED_NOW = 1_700_000_000_000;
const OPTION_ACTIONS_RE = /Option actions/;
const ADD_OPTION_RE = /Add option/i;
const RENAME_RE = /^Rename$/;
const DISABLE_RE = /^Disable$/;
const ENABLE_RE = /^Enable$/;
const DELETE_RE = /^Delete$/;
const COLOR_NONE_RE = /^Color: none$/;
const COLOR_RED_RE = /^Color: red$/;

let serverOptions: CustomFieldEnumOption[] = [];
let createOptionPending = false;
let capturedDragEnd: ((event: DragEndEvent) => void) | undefined;

const mockCreateOptionMutate = vi.fn();
const mockUpdateOptionMutate = vi.fn();
const mockReorderMutate = vi.fn();

vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useCustomFieldEnumOptions: () => ({ data: serverOptions }),
  useCreateEnumOption: () => ({
    mutate: mockCreateOptionMutate,
    isPending: createOptionPending,
  }),
  useUpdateEnumOption: () => ({
    mutate: mockUpdateOptionMutate,
    isPending: false,
  }),
  useReorderEnumOptions: () => ({
    mutate: mockReorderMutate,
    isPending: false,
  }),
}));

// jsdom cannot drive dnd-kit sensors; hand the builder's own onDragEnd back to
// the test while the real DndContext still wraps the rows.
vi.mock("@repo/app/shared/components/dnd-provider", async () => {
  const { DndContext } = await import("@dnd-kit/core");
  return {
    DndProvider: ({
      children,
      onDragEnd,
    }: {
      children: ReactNode;
      onDragEnd: (event: DragEndEvent) => void;
    }) => {
      capturedDragEnd = onDragEnd;
      return <DndContext>{children}</DndContext>;
    },
  };
});

// Radix's menu moves focus on open/close, which in jsdom blurs (and so commits)
// the rename input the moment it mounts. The row's own rename/disable/delete
// logic is the code under test, so the menu is a flat list of buttons that
// call each item's onSelect.
vi.mock("@repo/design-system/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect: () => void;
  }) => (
    <button onClick={onSelect} type="button">
      {children}
    </button>
  ),
}));

beforeEach(() => {
  serverOptions = [];
  createOptionPending = false;
  capturedDragEnd = undefined;
  // Create mode derives row ids from Date.now(); pin it so a drag can name them.
  vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("EnumOptionBuilder create mode", () => {
  it("seeds rows from the value, defaulting enabled to true and striking disabled rows", () => {
    renderCreate([
      { name: "Alpha" },
      { name: "Beta", enabled: false, color: CustomFieldOptionColor.Red },
    ]);

    expect(screen.getByText("Alpha").className).not.toContain("line-through");
    expect(screen.getByText("Beta").className).toContain("line-through");
    expect(
      screen.getByRole("button", { name: COLOR_NONE_RE })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: COLOR_RED_RE })
    ).toBeInTheDocument();

    expect(menuItem(0, DISABLE_RE)).toBeTruthy();
    expect(menuItem(1, ENABLE_RE)).toBeTruthy();
  });

  it("appends a default option and syncs it to the parent", () => {
    const onChange = renderCreate([]);

    fireEvent.click(screen.getByRole("button", { name: ADD_OPTION_RE }));

    expect(screen.getByText("New Option")).toBeTruthy();
    expect(onChange).toHaveBeenLastCalledWith([
      {
        name: "New Option",
        color: undefined,
        enabled: true,
        sortOrder: undefined,
      },
    ]);
  });

  it("toggles only the chosen option's enabled state through the actions menu", () => {
    const onChange = renderCreate([{ name: "Alpha" }, { name: "Beta" }]);

    fireEvent.click(menuItem(1, DISABLE_RE));

    expect(onChange).toHaveBeenLastCalledWith([
      { name: "Alpha", color: undefined, enabled: true, sortOrder: undefined },
      { name: "Beta", color: undefined, enabled: false, sortOrder: undefined },
    ]);
    expect(screen.getByText("Alpha").className).not.toContain("line-through");
    expect(screen.getByText("Beta").className).toContain("line-through");
  });

  it("deletes only the chosen option", () => {
    const onChange = renderCreate([{ name: "Alpha" }, { name: "Beta" }]);

    fireEvent.click(menuItem(0, DELETE_RE));

    expect(screen.queryByText("Alpha")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith([
      { name: "Beta", color: undefined, enabled: true, sortOrder: undefined },
    ]);
  });

  it("sets a colour, then clears it back to no colour", async () => {
    const onChange = renderCreate([{ name: "Alpha" }]);

    await userEvent.click(screen.getByRole("button", { name: COLOR_NONE_RE }));
    await userEvent.click(
      screen.getByRole("button", { name: CustomFieldOptionColor.Red })
    );
    expect(onChange).toHaveBeenLastCalledWith([
      {
        name: "Alpha",
        color: CustomFieldOptionColor.Red,
        enabled: true,
        sortOrder: undefined,
      },
    ]);

    // The swatch popover stays open after a pick.
    expect(screen.getByRole("button", { name: COLOR_RED_RE })).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: CustomFieldOptionColor.None })
    );
    expect(onChange).toHaveBeenLastCalledWith([
      { name: "Alpha", color: undefined, enabled: true, sortOrder: undefined },
    ]);
  });

  it("commits a trimmed rename on Enter", () => {
    const onChange = renderCreate([{ name: "Alpha" }]);

    const input = startRename(0);
    fireEvent.change(input, { target: { value: "  Omega  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenLastCalledWith([
      { name: "Omega", color: undefined, enabled: true, sortOrder: undefined },
    ]);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Omega")).toBeTruthy();
  });

  it("commits a rename on blur", () => {
    const onChange = renderCreate([{ name: "Alpha" }]);

    const input = startRename(0);
    fireEvent.change(input, { target: { value: "Blurred" } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenLastCalledWith([
      {
        name: "Blurred",
        color: undefined,
        enabled: true,
        sortOrder: undefined,
      },
    ]);
  });

  it.each([
    ["a blank name", "   "],
    ["the unchanged name", "Alpha"],
  ])("does not rename to %s and restores the label", (_label, typed) => {
    const onChange = renderCreate([{ name: "Alpha" }]);

    const input = startRename(0);
    fireEvent.change(input, { target: { value: typed } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Alpha")).toBeTruthy();
  });

  it("discards a rename on Escape and ignores other keys", () => {
    const onChange = renderCreate([{ name: "Alpha" }]);

    const input = startRename(0);
    fireEvent.change(input, { target: { value: "Discarded" } });
    fireEvent.keyDown(input, { key: "a" });
    expect(screen.getByRole("textbox")).toHaveValue("Discarded");

    fireEvent.keyDown(input, { key: "Escape" });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Alpha")).toBeTruthy();
  });

  it("gives each added option its own identity, so deleting one keeps the other", () => {
    // Row ids carry the clock, and two rows added in the same millisecond would
    // share one id.
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(FIXED_NOW + 1)
      .mockReturnValueOnce(FIXED_NOW + 2)
      .mockReturnValue(FIXED_NOW);
    const onChange = renderCreate([]);

    fireEvent.click(screen.getByRole("button", { name: ADD_OPTION_RE }));
    fireEvent.click(screen.getByRole("button", { name: ADD_OPTION_RE }));
    expect(screen.getAllByText("New Option")).toHaveLength(2);

    fireEvent.click(menuItem(0, DELETE_RE));

    expect(screen.getAllByText("New Option")).toHaveLength(1);
    expect(onChange).toHaveBeenLastCalledWith([
      {
        name: "New Option",
        color: undefined,
        enabled: true,
        sortOrder: undefined,
      },
    ]);
  });

  it("accepts a second rename after the first one commits", () => {
    const onChange = renderCreate([{ name: "Alpha" }]);

    const first = startRename(0);
    fireEvent.change(first, { target: { value: "Omega" } });
    fireEvent.keyDown(first, { key: "Enter" });

    const second = startRename(0);
    fireEvent.change(second, { target: { value: "Zeta" } });
    fireEvent.keyDown(second, { key: "Enter" });

    expect(onChange).toHaveBeenLastCalledWith([
      { name: "Zeta", color: undefined, enabled: true, sortOrder: undefined },
    ]);
    expect(screen.getByText("Zeta")).toBeTruthy();
  });

  it("builds local rows when fieldId is present but undefined", () => {
    const onChange = vi.fn();
    render(
      <EnumOptionBuilder fieldId={undefined} onChange={onChange} value={[]} />
    );

    fireEvent.click(screen.getByRole("button", { name: ADD_OPTION_RE }));

    expect(onChange).toHaveBeenLastCalledWith([
      {
        name: "New Option",
        color: undefined,
        enabled: true,
        sortOrder: undefined,
      },
    ]);
    expect(mockCreateOptionMutate).not.toHaveBeenCalled();
  });

  it("reorders on a valid drop and ignores no-target, same-row, and unknown-row drops", () => {
    const onChange = renderCreate([{ name: "Alpha" }, { name: "Beta" }]);
    const alphaId = `local-0-${FIXED_NOW}`;
    const betaId = `local-1-${FIXED_NOW}`;

    dragEnd(alphaId, null);
    dragEnd(alphaId, alphaId);
    dragEnd("missing", betaId);
    dragEnd(alphaId, "missing");
    expect(onChange).not.toHaveBeenCalled();

    dragEnd(betaId, alphaId);
    expect(onChange).toHaveBeenLastCalledWith([
      { name: "Beta", color: undefined, enabled: true, sortOrder: undefined },
      { name: "Alpha", color: undefined, enabled: true, sortOrder: undefined },
    ]);
  });
});

describe("EnumOptionBuilder edit mode row actions", () => {
  it("routes rename, colour, disable, and delete to the option update mutation", async () => {
    serverOptions = [serverOption("opt-a", "Alpha", 0, true)];
    render(<EnumOptionBuilder fieldId={FIELD_ID} />);

    const input = startRename(0);
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockUpdateOptionMutate).toHaveBeenLastCalledWith({
      optionId: "opt-a",
      name: "Renamed",
    });

    fireEvent.click(menuItem(0, DISABLE_RE));
    expect(mockUpdateOptionMutate).toHaveBeenLastCalledWith({
      optionId: "opt-a",
      enabled: false,
    });

    fireEvent.click(menuItem(0, DELETE_RE));
    // Edit-mode delete is a soft disable, never a hard delete — and it is its
    // own write, not the disable above.
    expect(mockUpdateOptionMutate).toHaveBeenLastCalledWith({
      optionId: "opt-a",
      enabled: false,
    });
    expect(mockUpdateOptionMutate).toHaveBeenCalledTimes(3);

    await userEvent.click(screen.getByRole("button", { name: COLOR_NONE_RE }));
    await userEvent.click(
      screen.getByRole("button", { name: CustomFieldOptionColor.Blue })
    );
    expect(mockUpdateOptionMutate).toHaveBeenLastCalledWith({
      optionId: "opt-a",
      color: CustomFieldOptionColor.Blue,
    });
  });

  it("enables a disabled option and clears a colour to undefined", async () => {
    serverOptions = [
      {
        ...serverOption("opt-a", "Alpha", 0, false),
        color: CustomFieldOptionColor.Red,
      },
    ];
    render(<EnumOptionBuilder fieldId={FIELD_ID} />);

    fireEvent.click(menuItem(0, ENABLE_RE));
    expect(mockUpdateOptionMutate).toHaveBeenLastCalledWith({
      optionId: "opt-a",
      enabled: true,
    });

    await userEvent.click(screen.getByRole("button", { name: COLOR_RED_RE }));
    await userEvent.click(
      screen.getByRole("button", { name: CustomFieldOptionColor.None })
    );
    expect(mockUpdateOptionMutate).toHaveBeenLastCalledWith({
      optionId: "opt-a",
      color: undefined,
    });
  });

  it("ignores no-target, same-row, and unknown-row drops", () => {
    serverOptions = [
      serverOption("opt-a", "Alpha", 0, true),
      serverOption("opt-b", "Beta", 1, true),
    ];
    render(<EnumOptionBuilder fieldId={FIELD_ID} />);

    dragEnd("opt-a", null);
    dragEnd("opt-a", "opt-a");
    dragEnd("opt-x", "opt-b");
    dragEnd("opt-a", "opt-x");

    expect(mockReorderMutate).not.toHaveBeenCalled();
  });

  it("disables Add option while a create is pending", () => {
    createOptionPending = true;
    render(<EnumOptionBuilder fieldId={FIELD_ID} />);

    expect(screen.getByRole("button", { name: ADD_OPTION_RE })).toBeDisabled();
  });
});

function renderCreate(value: CreateEnumOptionInput[]) {
  const onChange = vi.fn();
  render(<EnumOptionBuilder onChange={onChange} value={value} />);
  return onChange;
}

/** The row's menu item, located by the label the row renders. */
function menuItem(rowIndex: number, name: RegExp): HTMLElement {
  const rows = screen.getAllByRole("button", { name: OPTION_ACTIONS_RE });
  const row = rows[rowIndex].parentElement;
  if (!row) {
    throw new Error("option row did not render");
  }
  return within(row).getByRole("button", { name });
}

function startRename(rowIndex: number): HTMLElement {
  fireEvent.click(menuItem(rowIndex, RENAME_RE));
  return screen.getByRole("textbox");
}

function dragEnd(activeId: string, overId: string | null) {
  act(() =>
    capturedDragEnd?.({
      active: { id: activeId },
      over: overId === null ? null : { id: overId },
    } as DragEndEvent)
  );
}

function serverOption(
  id: string,
  name: string,
  sortOrder: number,
  enabled: boolean
): CustomFieldEnumOption {
  return {
    id,
    customFieldId: FIELD_ID,
    name,
    color: CustomFieldOptionColor.None,
    enabled,
    sortOrder,
  };
}
