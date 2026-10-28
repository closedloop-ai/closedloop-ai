// @vitest-environment jsdom

import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";
import {
  type TableCustomFieldDefinition,
  TableCustomFieldType,
} from "@repo/design-system/components/ui/table-add-field-dialog";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type GenericArtifact, genericArtifacts } from "../../fixtures";
import {
  CustomFieldCell,
  InlineCustomFieldCell,
} from "../artifact-custom-field-cell";
import { openRadixMenu } from "./support/radix-menu";
import {
  runLastToastUndo,
  type ToastSuccessHandler,
} from "./support/toast-spy";

const { toastSuccess } = vi.hoisted(() => ({
  toastSuccess: vi.fn<ToastSuccessHandler>(),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: toastSuccess },
}));

const FIELD_UPDATED = "Field updated";
const ADD_LABEL = "Add";
const EMPTY_SLOT = '[data-slot="grid-empty-value"]';

/** The champion's name for a reference trigger that holds a target. */
function REFERENCE_TRIGGER(source: string): RegExp {
  return new RegExp(`^Edit ${source} reference, currently `);
}

/** A four-character title keeps every title-derived default easy to read. */
const FILLED_ROW: GenericArtifact = {
  ...genericArtifacts[0],
  id: "artifact-1",
  title: "abcd",
};

/** Trailing id digit divisible by three: the row renders its empty state. */
const EMPTY_ROW: GenericArtifact = { ...FILLED_ROW, id: "artifact-3" };

function field(
  type: TableCustomFieldDefinition["type"],
  overrides: Partial<TableCustomFieldDefinition> = {}
): TableCustomFieldDefinition {
  return { id: "custom", label: "Custom", type, ...overrides };
}

function renderCell(
  artifact: GenericArtifact,
  definition: TableCustomFieldDefinition
) {
  return render(
    <CustomFieldCell
      artifact={artifact}
      field={definition}
      referenceArtifacts={genericArtifacts}
    />
  );
}

function withCreated(
  artifact: GenericArtifact,
  value: string | number | readonly string[] | null
): GenericArtifact {
  return { ...artifact, creationValues: { custom: value } };
}

beforeEach(() => {
  toastSuccess.mockReset();
});

describe("CustomFieldCell single-select", () => {
  const options = ["Alpha", "Beta", "Gamma"];

  it("picks the option at title length modulo the option count", () => {
    renderCell(
      FILLED_ROW,
      field(TableCustomFieldType.SingleSelect, { options })
    );

    expect(
      screen.getByRole("button", { name: "Edit Custom, currently Beta" })
    ).toHaveTextContent("Beta");
  });

  it("prefers a string creation value over the derived option", () => {
    renderCell(
      withCreated(FILLED_ROW, "Gamma"),
      field(TableCustomFieldType.SingleSelect, { options })
    );

    expect(
      screen.getByRole("button", { name: "Edit Custom, currently Gamma" })
    ).toBeInTheDocument();
  });

  it("ignores a non-string creation value and keeps the derived option", () => {
    renderCell(
      withCreated(FILLED_ROW, ["Alpha"]),
      field(TableCustomFieldType.SingleSelect, { options })
    );

    expect(
      screen.getByRole("button", { name: "Edit Custom, currently Beta" })
    ).toBeInTheDocument();
  });

  it("renders the empty state on an empty-state row with no creation value", () => {
    renderCell(
      EMPTY_ROW,
      field(TableCustomFieldType.SingleSelect, { options })
    );

    // ISS-9351 routes the select kinds through the shared cell, whose empty
    // state is the design system's own sentinel rather than the preview-local
    // "+ Add" affordance the scalar kinds still use. Whether "+ Add" should
    // come back for selects is an open product question on #7787.
    expect(
      screen
        .getByRole("button", { name: "Set Custom" })
        .querySelector(EMPTY_SLOT)
    ).not.toBeNull();
  });

  it("shows a creation value even on an empty-state row", () => {
    renderCell(
      withCreated(EMPTY_ROW, "Alpha"),
      field(TableCustomFieldType.SingleSelect, { options })
    );

    expect(
      screen.getByRole("button", { name: "Edit Custom, currently Alpha" })
    ).toBeInTheDocument();
  });

  it("renders empty when the field declares no options", () => {
    renderCell(FILLED_ROW, field(TableCustomFieldType.SingleSelect));

    expect(
      screen.getByRole("button", { name: "Set Custom" })
    ).toBeInTheDocument();
  });
});

describe("CustomFieldCell multi-select", () => {
  const options = ["Alpha", "Beta", "Gamma"];

  it("defaults to the first two options", () => {
    renderCell(
      FILLED_ROW,
      field(TableCustomFieldType.MultiSelect, { options })
    );

    expect(
      screen.getByRole("button", { name: "Edit Custom, currently Alpha, Beta" })
    ).toBeInTheDocument();
  });

  it("uses an array creation value as the selection", () => {
    renderCell(
      withCreated(FILLED_ROW, ["Gamma"]),
      field(TableCustomFieldType.MultiSelect, { options })
    );

    expect(
      screen.getByRole("button", { name: "Edit Custom, currently Gamma" })
    ).toBeInTheDocument();
  });

  it("renders none on an empty-state row and when no options exist", () => {
    renderCell(EMPTY_ROW, field(TableCustomFieldType.MultiSelect, { options }));
    renderCell(FILLED_ROW, field(TableCustomFieldType.MultiSelect));

    expect(screen.getAllByRole("button", { name: "Set Custom" })).toHaveLength(
      2
    );
  });
});

describe("CustomFieldCell date", () => {
  it("derives a July date from the title length", () => {
    renderCell(FILLED_ROW, field(TableCustomFieldType.Date, { label: "Due" }));

    expect(
      screen.getByRole("button", { name: "Edit Due: Jul 24, 2026" })
    ).toBeInTheDocument();
  });

  it("uses a string creation value and ignores a null one", () => {
    renderCell(
      withCreated(FILLED_ROW, "2026-01-05"),
      field(TableCustomFieldType.Date, { label: "Due" })
    );
    renderCell(
      withCreated(FILLED_ROW, null),
      field(TableCustomFieldType.Date, { label: "Start" })
    );

    expect(
      screen.getByRole("button", { name: "Edit Due: Jan 5, 2026" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit Start: Jul 24, 2026" })
    ).toBeInTheDocument();
  });

  it("offers Set on an empty-state row", () => {
    renderCell(EMPTY_ROW, field(TableCustomFieldType.Date, { label: "Due" }));

    expect(
      screen.getByRole("button", { name: "Set Edit Due" })
    ).toBeInTheDocument();
  });
});

describe("CustomFieldCell number and text", () => {
  it("derives a number from the title length, or reads a creation value", () => {
    renderCell(
      FILLED_ROW,
      field(TableCustomFieldType.Number, { label: "Pts" })
    );
    renderCell(
      withCreated(FILLED_ROW, 42),
      field(TableCustomFieldType.Number, { label: "Est" })
    );
    renderCell(
      withCreated(FILLED_ROW, "7"),
      field(TableCustomFieldType.Number, { label: "Size" })
    );

    expect(screen.getByRole("spinbutton", { name: "Edit Pts" })).toHaveValue(
      128
    );
    expect(screen.getByRole("spinbutton", { name: "Edit Est" })).toHaveValue(
      42
    );
    expect(screen.getByRole("spinbutton", { name: "Edit Size" })).toHaveValue(
      7
    );
  });

  it("renders fixed copy unless the creation value is a string", () => {
    renderCell(FILLED_ROW, field(TableCustomFieldType.Text, { label: "A" }));
    renderCell(
      withCreated(FILLED_ROW, 5),
      field(TableCustomFieldType.Text, { label: "B" })
    );
    renderCell(
      withCreated(FILLED_ROW, "Written"),
      field(TableCustomFieldType.Text, { label: "C" })
    );

    expect(screen.getByRole("textbox", { name: "Edit A" })).toHaveValue(
      "Custom text value"
    );
    expect(screen.getByRole("textbox", { name: "Edit B" })).toHaveValue(
      "Custom text value"
    );
    expect(screen.getByRole("textbox", { name: "Edit C" })).toHaveValue(
      "Written"
    );
  });

  it("renders Set buttons for number and text on an empty-state row", () => {
    renderCell(EMPTY_ROW, field(TableCustomFieldType.Number, { label: "Pts" }));
    renderCell(EMPTY_ROW, field(TableCustomFieldType.Text, { label: "Note" }));

    expect(
      screen.getByRole("button", { name: "Set Edit Pts" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Set Edit Note" })
    ).toBeInTheDocument();
  });
});

describe("CustomFieldCell people", () => {
  it("renders the row owner as the editable person", () => {
    renderCell(EMPTY_ROW, field(TableCustomFieldType.People));

    expect(
      screen.getByRole("button", {
        name: `Edit owner, currently ${FILLED_ROW.owner}`,
      })
    ).toHaveTextContent(
      // One initial on every avatar (Nerys, 2026-10-22): the row's stored
      // initials draw their first letter, beside the owner's name.
      `${FILLED_ROW.ownerInitials.charAt(0)}${FILLED_ROW.owner}`
    );
  });
});

describe("CustomFieldCell references", () => {
  // PRD-722 (ISS-9349): the reference cell is the champion's, so its trigger
  // is named for the targets it holds and its rows are options.
  it("selects the first rotated candidate of the declared source", () => {
    renderCell(
      FILLED_ROW,
      field(TableCustomFieldType.Reference, { sources: ["Documents"] })
    );

    fireEvent.click(
      screen.getByRole("button", { name: REFERENCE_TRIGGER("Documents") })
    );

    const options = within(screen.getByRole("dialog"))
      .getAllByRole("option")
      .filter((option) => option.textContent?.includes("DOC-"));
    expect(options.map((option) => option.textContent)).toEqual([
      "DOC-184Artifact interaction principles",
      "DOC-167Sessions product brief",
    ]);
    expect(options[0]?.querySelector(".lucide-check")).not.toBeNull();
    expect(options[1]?.querySelector(".lucide-check")).toBeNull();
  });

  it("selects up to three references for a multi reference", () => {
    renderCell(FILLED_ROW, field(TableCustomFieldType.ReferenceMulti));

    fireEvent.click(
      screen.getByRole("button", { name: REFERENCE_TRIGGER("artifact") })
    );

    expect(screen.getByText("3 selected")).toBeInTheDocument();
  });

  it("renders the empty state for a source with no artifact kind", () => {
    renderCell(
      FILLED_ROW,
      field(TableCustomFieldType.Reference, { sources: ["Projects"] })
    );

    const trigger = screen.getByRole("button", {
      name: "Set Projects reference",
    });
    expect(trigger.querySelector(EMPTY_SLOT)).not.toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText("No matching artifacts")).toBeInTheDocument();
  });

  it("renders empty on an empty-state row", () => {
    renderCell(EMPTY_ROW, field(TableCustomFieldType.ReferenceMulti));

    expect(
      screen
        .getByRole("button", { name: "Set artifact reference" })
        .querySelector(EMPTY_SLOT)
    ).not.toBeNull();
  });
});

describe("CustomFieldCell time", () => {
  const TIME_LABEL = "Edit Slot";

  function timeInput() {
    return screen.getByLabelText(TIME_LABEL);
  }

  it("derives a time from the title length and focuses the field", () => {
    renderCell(FILLED_ROW, field(TableCustomFieldType.Time, { label: "Slot" }));

    expect(timeInput()).toHaveValue("02:16");
    expect(timeInput()).toHaveFocus();
  });

  it("reads a numeric creation value as its string form", () => {
    renderCell(
      withCreated(FILLED_ROW, 930),
      field(TableCustomFieldType.Time, { label: "Slot" })
    );
    expect(timeInput()).toHaveAttribute("value", "930");
  });

  it("reads a string creation value as given", () => {
    renderCell(
      withCreated(FILLED_ROW, "07:45"),
      field(TableCustomFieldType.Time, { label: "Slot" })
    );
    expect(timeInput()).toHaveValue("07:45");
  });

  it("opens an editor from the empty state", () => {
    renderCell(EMPTY_ROW, field(TableCustomFieldType.Time, { label: "Slot" }));

    fireEvent.click(screen.getByRole("button", { name: TIME_LABEL }));

    expect(timeInput()).toHaveValue("");
    expect(timeInput()).toHaveFocus();
  });

  it("commits on Enter, then undoes back to the previous time", () => {
    renderCell(FILLED_ROW, field(TableCustomFieldType.Time, { label: "Slot" }));

    fireEvent.change(timeInput(), { target: { value: "09:30" } });
    fireEvent.keyDown(timeInput(), { key: "Enter" });
    fireEvent.blur(timeInput());

    // pins current behavior; looks odd because Enter's own blur() re-runs commit with the pre-commit value still in scope, so one Enter raises two toasts
    expect(toastSuccess).toHaveBeenCalledTimes(2);
    expect(toastSuccess).toHaveBeenLastCalledWith(
      FIELD_UPDATED,
      expect.objectContaining({
        action: expect.objectContaining({ label: "Undo" }),
      })
    );
    expect(timeInput()).toHaveValue("09:30");

    runLastToastUndo(toastSuccess);
    expect(timeInput()).toHaveValue("02:16");
  });

  it("commits on blur and does nothing when the draft is unchanged", () => {
    renderCell(FILLED_ROW, field(TableCustomFieldType.Time, { label: "Slot" }));

    fireEvent.blur(timeInput());
    expect(toastSuccess).not.toHaveBeenCalled();

    fireEvent.change(timeInput(), { target: { value: "10:00" } });
    fireEvent.blur(timeInput());
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("reverts the draft on Escape without committing", () => {
    renderCell(FILLED_ROW, field(TableCustomFieldType.Time, { label: "Slot" }));

    fireEvent.change(timeInput(), { target: { value: "11:11" } });
    fireEvent.keyDown(timeInput(), { key: "Escape" });
    fireEvent.blur(timeInput());

    expect(timeInput()).toHaveValue("02:16");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("ignores other keys", () => {
    renderCell(FILLED_ROW, field(TableCustomFieldType.Time, { label: "Slot" }));

    fireEvent.change(timeInput(), { target: { value: "11:11" } });
    fireEvent.keyDown(timeInput(), { key: "Tab" });

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(timeInput()).toHaveValue("11:11");
  });

  it("collapses to the empty button when cleared, and undo restores the time", () => {
    renderCell(FILLED_ROW, field(TableCustomFieldType.Time, { label: "Slot" }));

    fireEvent.change(timeInput(), { target: { value: "" } });
    fireEvent.keyDown(timeInput(), { key: "Enter" });

    const emptyButton = screen.getByRole("button", { name: TIME_LABEL });
    expect(emptyButton).toHaveTextContent(ADD_LABEL);

    runLastToastUndo(toastSuccess);
    expect(timeInput()).toHaveValue("02:16");
  });

  it("undo of a first value collapses back to the empty button", () => {
    renderCell(EMPTY_ROW, field(TableCustomFieldType.Time, { label: "Slot" }));
    fireEvent.click(screen.getByRole("button", { name: TIME_LABEL }));

    fireEvent.change(timeInput(), { target: { value: "08:00" } });
    fireEvent.keyDown(timeInput(), { key: "Enter" });
    expect(timeInput()).toHaveValue("08:00");

    runLastToastUndo(toastSuccess);
    expect(
      within(screen.getByRole("button", { name: TIME_LABEL })).getByText(
        ADD_LABEL
      )
    ).toBeInTheDocument();
  });
});

describe("InlineCustomFieldCell", () => {
  it("toasts on commit and restores the previous value on undo", () => {
    render(
      <InlineCustomFieldCell
        ariaLabel="Edit Notes"
        initialValue="First"
        type="text"
      />
    );
    const input = screen.getByRole("textbox", { name: "Edit Notes" });

    fireEvent.change(input, { target: { value: "Second" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(toastSuccess).toHaveBeenCalledWith(FIELD_UPDATED, expect.anything());
    expect(input).toHaveValue("Second");

    runLastToastUndo(toastSuccess);
    expect(screen.getByRole("textbox", { name: "Edit Notes" })).toHaveValue(
      "First"
    );
  });

  it("retains a refused edit beside its save error", async () => {
    toastSuccess.mockImplementationOnce(() => {
      throw new Error("save refused");
    });
    render(
      <InlineCustomFieldCell
        ariaLabel="Edit Notes"
        initialValue="First"
        type="text"
      />
    );
    const input = screen.getByRole("textbox", { name: "Edit Notes" });

    fireEvent.change(input, { target: { value: "Second" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(input).toHaveValue("Second"));
    expect(input).toHaveAccessibleDescription(INLINE_EDIT_SAVE_ERROR_MESSAGE);
    expect(screen.getByRole("alert")).toHaveTextContent(
      INLINE_EDIT_SAVE_ERROR_MESSAGE
    );
  });
});

describe("CustomFieldCell edge inputs", () => {
  const options = ["Alpha", "Beta", "Gamma"];

  it("reads the empty-state marker from the whole last id segment", () => {
    // "13" is not a multiple of three; its last digit and the middle "12" are.
    renderCell(
      { ...FILLED_ROW, id: "row-12-13" },
      field(TableCustomFieldType.SingleSelect, { options })
    );

    expect(
      screen.getByRole("button", { name: "Edit Custom, currently Beta" })
    ).toBeInTheDocument();
  });

  it("offers no single-select options when the field declares none", () => {
    renderCell(FILLED_ROW, field(TableCustomFieldType.SingleSelect));
    openRadixMenu(screen.getByRole("button", { name: "Set Custom" }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.queryAllByRole("menuitemradio")).toEqual([]);
  });

  it("offers no multi-select options when the field declares none", () => {
    renderCell(FILLED_ROW, field(TableCustomFieldType.MultiSelect));
    openRadixMenu(screen.getByRole("button", { name: "Set Custom" }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.queryAllByRole("menuitemcheckbox")).toEqual([]);
  });

  it("leaves single-select chips uncoloured without declared colours", () => {
    renderCell(
      FILLED_ROW,
      field(TableCustomFieldType.SingleSelect, { options })
    );
    openRadixMenu(
      screen.getByRole("button", { name: "Edit Custom, currently Beta" })
    );

    const alpha = screen.getByRole("menuitemradio", { name: "Alpha" });
    expect(within(alpha).getByText("Alpha")).not.toHaveClass("text-white");
  });

  it("leaves multi-select chips uncoloured without declared colours", () => {
    renderCell(
      FILLED_ROW,
      field(TableCustomFieldType.MultiSelect, { options })
    );

    // Without declared colours the shared cell gives each option no chip class
    // at all, so the picked values render as plain text rather than as
    // uncoloured chips — the same "no colour was invented" fact, one layer out.
    const nodes = screen.getAllByText("Alpha");
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.closest('[data-slot="chip"]')).toBeNull();
      expect(node).not.toHaveClass("text-white");
    }
  });

  it("closes a single reference picker on pick and says Reference updated", async () => {
    renderCell(FILLED_ROW, field(TableCustomFieldType.Reference));
    fireEvent.click(
      screen.getByRole("button", { name: REFERENCE_TRIGGER("artifact") })
    );
    const [, second] = within(screen.getByRole("dialog")).getAllByRole(
      "option"
    );
    if (!second) {
      throw new Error("the picker lists fewer than two references");
    }

    fireEvent.click(second);
    // The champion dispatches the commit a microtask after the pick.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toastSuccess).toHaveBeenCalledWith(
      "Reference updated",
      expect.anything()
    );
  });

  it("renders a single reference empty on an empty-state row", () => {
    renderCell(EMPTY_ROW, field(TableCustomFieldType.Reference));

    expect(
      screen
        .getByRole("button", { name: "Set artifact reference" })
        .querySelector(EMPTY_SLOT)
    ).not.toBeNull();
  });

  it("zero-pads a single-digit derived minute", () => {
    renderCell(
      { ...FILLED_ROW, title: "x".repeat(50) },
      field(TableCustomFieldType.Time, { label: "Slot" })
    );

    expect(screen.getByLabelText("Edit Slot")).toHaveValue("02:02");
  });

  it("commits a later blur after an Escape has been consumed", () => {
    renderCell(FILLED_ROW, field(TableCustomFieldType.Time, { label: "Slot" }));
    const input = screen.getByLabelText("Edit Slot");

    fireEvent.change(input, { target: { value: "11:11" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "12:30" } });
    fireEvent.blur(input);

    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue("12:30");
  });
});
