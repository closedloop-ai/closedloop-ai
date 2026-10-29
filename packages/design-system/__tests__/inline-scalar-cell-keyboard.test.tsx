import { GridTableV2 } from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { InlineScalarCell } from "@closedloop-ai/design-system/components/ui/inline-scalar-cell";
import { gridCellOf as cellOf } from "@closedloop-ai/design-system/test/grid-roving-tab-stop";
import { INVALID_MESSAGE } from "@closedloop-ai/design-system/test/inline-scalar-cell-fixtures";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * ISS-9490 — where focus goes when a keyboard user finishes with an inline
 * scalar field. Each case asserts the ELEMENT that holds focus afterwards,
 * because the defect is focus landing on `<body>` (or bouncing back into the
 * field), which a commit assertion alone cannot see.
 */

type Row = { id: string; name: string; estimate: string; note: string };

const ROWS: Row[] = [
  { id: "alpha", name: "Alpha", estimate: "7", note: "Ship it" },
  { id: "bravo", name: "Bravo", estimate: "", note: "" },
];

const COLUMNS = [
  { id: "estimate", label: "Estimate" },
  { id: "note", label: "Note" },
];

function ControlledCell({
  label,
  initial,
  onCommit,
  type,
  echoes = true,
}: Readonly<{
  label: string;
  initial: string;
  onCommit: (next: string) => void;
  type?: "number" | "text";
  /** False for a host that accepts a commit without handing `value` back yet. */
  echoes?: boolean;
}>) {
  const [value, setValue] = useState(initial);
  const commit = (next: string) => {
    if (echoes) {
      setValue(next);
    }
    onCommit(next);
  };
  // ISS-9590: a numeric cell carries its refusal words or it does not compile,
  // so the harness no longer takes them as an option — the wordless variant
  // these cases used to be able to render is gone.
  if (type === "number") {
    return (
      <InlineScalarCell
        invalidMessage={INVALID_MESSAGE}
        label={label}
        onCommit={commit}
        type="number"
        value={value}
      />
    );
  }
  return (
    <InlineScalarCell
      label={label}
      onCommit={commit}
      type={type}
      value={value}
    />
  );
}

function renderGrid(type?: "number" | "text", echoes = true) {
  const onCommit = vi.fn();
  render(
    <GridTableV2<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns="200px 120px 120px"
      items={ROWS}
      leadingLabel="Name"
      renderCell={(columnId, row) => (
        <ControlledCell
          echoes={echoes}
          initial={columnId === "estimate" ? row.estimate : row.note}
          label={`${columnId === "estimate" ? "Estimate" : "Note"} for ${row.name}`}
          onCommit={onCommit}
          type={columnId === "estimate" ? type : "text"}
        />
      )}
      renderLead={(row) => <span>{row.name}</span>}
    />
  );
  return { onCommit };
}

/** Enter the cell the way a keyboard user does, and return its field. */
function enterField(name: string): HTMLElement {
  const field = screen.getByRole("textbox", { name });
  act(() => cellOf(field).focus());
  fireEvent.keyDown(cellOf(field), { key: "Enter" });
  if (document.activeElement !== field) {
    throw new Error(`Enter on the cell did not reach "${name}"`);
  }
  return field;
}

describe("InlineScalarCell in a navigable grid", () => {
  it("commits on Enter and hands focus back to its cell, so arrow navigation resumes", () => {
    const { onCommit } = renderGrid();
    const field = enterField("Estimate for Alpha");

    fireEvent.change(field, { target: { value: "9" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("9");
    expect(cellOf(field)).toHaveFocus();

    fireEvent.keyDown(cellOf(field), { key: "ArrowDown" });
    expect(
      cellOf(screen.getByRole("button", { name: "Set Estimate for Bravo" }))
    ).toHaveFocus();
  });

  it("PRD-722 DT-070 keeps a synchronously refused retained draft focused and retryable", () => {
    const onCommit = vi
      .fn<(next: string) => Promise<void>>()
      .mockImplementationOnce(() => {
        throw new Error("refused");
      })
      .mockResolvedValueOnce(undefined);
    render(
      <GridTableV2<Row>
        columns={[COLUMNS[0]]}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={[ROWS[0]]}
        leadingLabel="Name"
        renderCell={() => (
          <InlineScalarCell
            label="Estimate for Alpha"
            onCommit={onCommit}
            retainRejectedDraft
            saveErrorMessage="Save failed"
            value="7"
          />
        )}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
    const field = enterField("Estimate for Alpha");

    fireEvent.change(field, { target: { value: "9" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(onCommit).toHaveBeenCalledExactlyOnceWith("9");
    expect(field).toHaveFocus();
    expect(field).toHaveValue("9");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("Save failed");
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");

    field.blur();
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith("9");
  });

  // F-1 ruling (2026-10-20): focus still on the field's own cell after Enter is
  // the edit's, so a refusal returns it to the field, as the title hosts do.
  it("returns focus to the field when a refusal lands while its grid cell holds focus", async () => {
    let rejectCommit: ((reason: unknown) => void) | undefined;
    const onCommit = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCommit = reject;
        })
    );
    render(
      <GridTableV2<Row>
        columns={[COLUMNS[0]]}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={[ROWS[0]]}
        leadingLabel="Name"
        renderCell={() => (
          <InlineScalarCell
            label="Estimate for Alpha"
            onCommit={onCommit}
            retainRejectedDraft
            saveErrorMessage="Save failed"
            value="7"
          />
        )}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
    const field = enterField("Estimate for Alpha");
    const gridCell = cellOf(field);

    fireEvent.change(field, { target: { value: "9" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(gridCell).toHaveFocus();

    await act(async () => {
      rejectCommit?.(new Error("refused"));
      await Promise.resolve();
    });

    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveValue("9");
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
  });

  it("reverts on Escape without committing, and hands focus back to the cell after the field collapses", async () => {
    const { onCommit } = renderGrid();
    const setButton = screen.getByRole("button", {
      name: "Set Estimate for Bravo",
    });
    const cell = cellOf(setButton);
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: "Enter" });
    fireEvent.click(setButton);
    const field = await screen.findByRole("textbox", {
      name: "Estimate for Bravo",
    });
    expect(field).toHaveFocus();

    fireEvent.change(field, { target: { value: "3" } });
    fireEvent.keyDown(field, { key: "Escape" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Set Estimate for Bravo" })
    ).toBeInTheDocument();
    expect(cell).toHaveFocus();
  });

  it("commits on Tab and advances to the next cell in the row", () => {
    const { onCommit } = renderGrid();
    const field = enterField("Estimate for Alpha");
    const noteCell = cellOf(
      screen.getByRole("textbox", { name: "Note for Alpha" })
    );

    fireEvent.change(field, { target: { value: "9" } });
    // `false` means the handler called `preventDefault`: the grid moved focus
    // itself instead of leaving Tab to walk out of the grid.
    expect(fireEvent.keyDown(field, { key: "Tab" })).toBe(false);

    expect(onCommit).toHaveBeenCalledWith("9");
    expect(noteCell).toHaveFocus();
  });

  it("moves back a cell on Shift+Tab", () => {
    renderGrid();
    const field = enterField("Estimate for Alpha");
    const leadCell = cellOf(screen.getByText("Alpha"));

    expect(fireEvent.keyDown(field, { key: "Tab", shiftKey: true })).toBe(
      false
    );

    expect(leadCell).toHaveFocus();
  });

  it("leaves Tab native at the row's last cell, so it can leave the grid", () => {
    renderGrid();
    const field = enterField("Note for Alpha");

    expect(fireEvent.keyDown(field, { key: "Tab" })).toBe(true);
    expect(field).toHaveFocus();
  });

  it("keeps focus on an unparseable number on Enter, announces it, and clears it on Escape", () => {
    const { onCommit } = renderGrid("number");
    const field = typeUnparseableNumber("Estimate for Alpha");

    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(INVALID_MESSAGE);
    expect(screen.getByRole("alert")).toHaveTextContent(INVALID_MESSAGE);

    fireEvent.keyDown(field, { key: "Enter" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(field).toHaveFocus();

    fireEvent.keyDown(field, { key: "Escape" });

    expect(field).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field).toHaveValue(7);
    expect(cellOf(field)).toHaveFocus();
  });

  it("lets Tab leave an unparseable number, and keeps saying it did not save", () => {
    const { onCommit } = renderGrid("number");
    const field = typeUnparseableNumber("Estimate for Alpha");
    const noteCell = cellOf(
      screen.getByRole("textbox", { name: "Note for Alpha" })
    );

    fireEvent.keyDown(field, { key: "Tab" });

    expect(noteCell).toHaveFocus();
    expect(onCommit).not.toHaveBeenCalled();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(INVALID_MESSAGE);
    expect(screen.getByRole("alert")).toHaveTextContent(INVALID_MESSAGE);
  });

  it("keeps an empty cell's saved value on Escape before the host echoes it", async () => {
    const { onCommit } = renderGrid(undefined, false);
    const setButton = screen.getByRole("button", {
      name: "Set Estimate for Bravo",
    });
    act(() => cellOf(setButton).focus());
    fireEvent.keyDown(cellOf(setButton), { key: "Enter" });
    fireEvent.click(setButton);
    const opened = await screen.findByRole("textbox", {
      name: "Estimate for Bravo",
    });
    fireEvent.change(opened, { target: { value: "9" } });
    fireEvent.keyDown(opened, { key: "Enter" });

    const field = enterField("Estimate for Bravo");
    fireEvent.change(field, { target: { value: "12" } });
    fireEvent.keyDown(field, { key: "Escape" });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("textbox", { name: "Estimate for Bravo" })
    ).toHaveValue("9");
    expect(cellOf(field)).toHaveFocus();
  });
});

describe("InlineScalarCell validity on an empty number", () => {
  // `value` reads "" both when the field is empty and when it holds `12e`, so
  // React fires no `onChange` for either move; only the native input sees it.
  it("marks and clears invalid input that never changes the value", async () => {
    renderGrid("number");
    fireEvent.click(
      screen.getByRole("button", { name: "Set Estimate for Bravo" })
    );
    const field = await screen.findByRole("spinbutton", {
      name: "Estimate for Bravo",
    });
    const validity = { badInput: true };
    Object.defineProperty(field, "validity", {
      configurable: true,
      value: validity,
    });

    fireEvent.input(field);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(INVALID_MESSAGE);
    expect(screen.getByRole("alert")).toHaveTextContent(INVALID_MESSAGE);

    validity.badInput = false;
    fireEvent.input(field);
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

/** Enter a numeric cell and leave it holding input the browser cannot parse. */
function typeUnparseableNumber(name: string): HTMLElement {
  const field = screen.getByRole("spinbutton", { name });
  act(() => cellOf(field).focus());
  fireEvent.keyDown(cellOf(field), { key: "Enter" });
  // The browser blanks `value` for `12e` and sets `badInput`. jsdom does not
  // compute validity, so it is stubbed here.
  Object.defineProperty(field, "validity", {
    configurable: true,
    value: { badInput: true },
  });
  fireEvent.change(field, { target: { value: "" } });
  return field;
}

describe("InlineScalarCell outside a grid", () => {
  function Standalone({
    initial,
    onCommit,
  }: Readonly<{ initial: string; onCommit: (next: string) => void }>) {
    return (
      <>
        <ControlledCell
          initial={initial}
          label="Estimate"
          onCommit={onCommit}
        />
        <button type="button">Next</button>
      </>
    );
  }

  it("does not pull focus back into a filled field the user just left", () => {
    const onCommit = vi.fn();
    render(<Standalone initial="7" onCommit={onCommit} />);
    const field = screen.getByRole("textbox", { name: "Estimate" });
    const next = screen.getByRole("button", { name: "Next" });

    act(() => field.focus());
    fireEvent.change(field, { target: { value: "9" } });
    act(() => next.focus());

    expect(onCommit).toHaveBeenCalledWith("9");
    expect(next).toHaveFocus();
  });

  it("does not pull focus back after an async refusal when the user moved on", async () => {
    let rejectCommit: ((reason: unknown) => void) | undefined;
    const onCommit = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCommit = reject;
        })
    );
    render(
      <>
        <InlineScalarCell
          label="Estimate"
          onCommit={onCommit}
          retainRejectedDraft
          saveErrorMessage="Save failed"
          value="7"
        />
        <button type="button">Next</button>
      </>
    );
    const field = screen.getByRole("textbox", { name: "Estimate" });
    const next = screen.getByRole("button", { name: "Next" });

    act(() => field.focus());
    fireEvent.change(field, { target: { value: "9" } });
    act(() => next.focus());
    await act(async () => {
      rejectCommit?.(new Error("refused"));
      await Promise.resolve();
    });

    expect(next).toHaveFocus();
    expect(field).toHaveValue("9");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
  });

  it("keeps focus on the field after Enter commits", () => {
    const onCommit = vi.fn();
    render(<Standalone initial="7" onCommit={onCommit} />);
    const field = screen.getByRole("textbox", { name: "Estimate" });

    act(() => field.focus());
    fireEvent.change(field, { target: { value: "9" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(field).toHaveFocus();
  });

  it("returns focus to the empty-state button when Escape closes a field it opened", async () => {
    const onCommit = vi.fn();
    render(<Standalone initial="" onCommit={onCommit} />);

    fireEvent.click(screen.getByRole("button", { name: "Set Estimate" }));
    const field = await screen.findByRole("textbox", { name: "Estimate" });
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "3" } });
    fireEvent.keyDown(field, { key: "Escape" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Set Estimate" })).toHaveFocus();
  });

  it("keeps an empty cell's saved value on Escape before the host echoes it", async () => {
    const onCommit = vi.fn();
    render(<InlineScalarCell label="Estimate" onCommit={onCommit} value="" />);

    fireEvent.click(screen.getByRole("button", { name: "Set Estimate" }));
    const field = await screen.findByRole("textbox", { name: "Estimate" });
    fireEvent.change(field, { target: { value: "9" } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.change(field, { target: { value: "12" } });
    fireEvent.keyDown(field, { key: "Escape" });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(field).toHaveValue("9");
    expect(field).toHaveFocus();
  });
});
