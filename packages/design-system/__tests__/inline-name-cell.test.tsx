import { GridTableV2 } from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { InlineNameCell } from "@closedloop-ai/design-system/components/ui/inline-name-cell";
import { gridCellOf } from "@closedloop-ai/design-system/test/grid-roving-tab-stop";
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
 * ISS-8718 — the grid-table name editor. What it composes from
 * `InlineScalarCell` is covered by that cell's own suites; these cases pin the
 * three rules that are this component's, plus the resting render that is the
 * reason it holds any state at all.
 */

const LABEL = "Edit name for a row";
const NAME = "session/mine-to-rename";

function openEditor<T extends HTMLElement = HTMLElement>(): T {
  fireEvent.click(screen.getByRole("button", { name: LABEL }));
  return screen.getByRole<T>("textbox", { name: LABEL });
}

describe("InlineNameCell", () => {
  it("rests as the host's node plus an edit control, and opens the field over it", () => {
    render(
      <InlineNameCell
        label={LABEL}
        onCommit={vi.fn()}
        renderValue={(shown) => <a href="#row">{shown}</a>}
        value={NAME}
      />
    );

    // The link is the row's only route into the record, which is why the field
    // is revealed rather than always-live.
    expect(screen.getByRole("link", { name: NAME })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();

    const field = openEditor();
    expect(field).toHaveValue(NAME);
    expect(screen.queryByRole("link", { name: NAME })).toBeNull();
  });

  it("focuses and selects the value on open, because opening a name offers to replace it", () => {
    render(<InlineNameCell label={LABEL} onCommit={vi.fn()} value={NAME} />);

    const field = openEditor<HTMLInputElement>();
    expect(field).toHaveFocus();
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(NAME.length);
  });

  it("trims a commit and carries the shown name as the expected value", async () => {
    const onCommit = vi.fn();
    render(<InlineNameCell label={LABEL} onCommit={onCommit} value={NAME} />);

    const field = openEditor();
    fireEvent.change(field, { target: { value: "  renamed  " } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("renamed", NAME));
  });

  it("treats a blank draft as a cancel, never as an erasure", async () => {
    // The rule that stops this being a mode on `InlineScalarCell`: clearing a
    // SCALAR is how a user unsets it, and a name has no such reading.
    const onCommit = vi.fn();
    render(
      <InlineNameCell
        label={LABEL}
        onCommit={onCommit}
        renderValue={(shown) => <a href="#row">{shown}</a>}
        value={NAME}
      />
    );

    const field = openEditor();
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(onCommit).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("link", { name: NAME })).toBeInTheDocument()
    );
  });

  it("shows the committed name without the host echoing it back", async () => {
    // A host fed its rows as props has nothing for an optimistic cache patch to
    // flow through. A resting render keyed only on `value` shows the OLD name
    // after a successful rename — the shape that made ISS-8718's
    // `CommittedRename` story unprovable.
    render(
      <InlineNameCell
        label={LABEL}
        onCommit={() => Promise.resolve()}
        renderValue={(shown) => <a href="#row">{shown}</a>}
        value={NAME}
      />
    );

    const field = openEditor();
    fireEvent.change(field, { target: { value: "renamed" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "renamed" })).toBeInTheDocument()
    );
  });

  it("yields an accepted memo to a later authoritative host value", async () => {
    const onCommit = vi.fn(() => Promise.resolve());
    const { rerender } = render(
      <InlineNameCell
        label={LABEL}
        onCommit={onCommit}
        renderValue={(shown) => <a href="#row">{shown}</a>}
        value={NAME}
      />
    );

    const field = openEditor();
    fireEvent.change(field, { target: { value: "accepted locally" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "accepted locally" })
      ).toBeInTheDocument()
    );

    rerender(
      <InlineNameCell
        label={LABEL}
        onCommit={onCommit}
        renderValue={(shown) => <a href="#row">{shown}</a>}
        value="authoritative refetch"
      />
    );
    expect(
      screen.getByRole("link", { name: "authoritative refetch" })
    ).toBeInTheDocument();

    const nextField = openEditor();
    fireEvent.change(nextField, { target: { value: "next rename" } });
    fireEvent.keyDown(nextField, { key: "Enter" });
    await waitFor(() =>
      expect(onCommit).toHaveBeenLastCalledWith(
        "next rename",
        "authoritative refetch"
      )
    );
  });

  it("PRD-722 DT-066 returns to the resting render after a compatibility-mode refusal", async () => {
    render(
      <InlineNameCell
        label={LABEL}
        onCommit={() => Promise.reject(new Error("refused"))}
        renderValue={(shown) => <a href="#row">{shown}</a>}
        value={NAME}
      />
    );

    const field = openEditor();
    fireEvent.change(field, { target: { value: "never lands" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByRole("link", { name: NAME })).toBeInTheDocument()
    );
    expect(screen.queryByRole("textbox", { name: LABEL })).toBeNull();
  });

  it("closes the editor on Enter without waiting for the write in compatibility mode", () => {
    const onCommit = vi.fn(() => new Promise<void>(() => undefined));
    render(
      <InlineNameCell
        label={LABEL}
        onCommit={onCommit}
        renderValue={(shown) => <a href="#row">{shown}</a>}
        value={NAME}
      />
    );

    const field = openEditor();
    fireEvent.change(field, { target: { value: "in flight" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(onCommit).toHaveBeenCalledWith("in flight", NAME);
    expect(screen.queryByRole("textbox", { name: LABEL })).toBeNull();
  });

  it("PRD-722 DT-074 returns to rest after a synchronous compatibility refusal", async () => {
    render(
      <InlineNameCell
        label={LABEL}
        onCommit={() => {
          throw new Error("refused");
        }}
        renderValue={(shown) => <a href="#row">{shown}</a>}
        value={NAME}
      />
    );

    const field = openEditor();
    fireEvent.change(field, { target: { value: "never lands" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByRole("link", { name: NAME })).toBeInTheDocument()
    );
    expect(screen.queryByRole("textbox", { name: LABEL })).toBeNull();
  });

  it("keeps a refused draft mounted, focused, and associated with its error", async () => {
    render(
      <InlineNameCell
        label={LABEL}
        onCommit={() => Promise.reject(new Error("refused"))}
        renderValue={(shown) => <a href="#row">{shown}</a>}
        retainRejectedDraft
        saveErrorMessage="Couldn't save changes. Try again."
        value={NAME}
      />
    );

    const field = openEditor();
    fireEvent.change(field, { target: { value: "never lands" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveValue("never lands");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(
      "Couldn't save changes. Try again."
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't save changes. Try again."
    );
  });

  it("returns focus to the field when the grid moved it to the owning cell before the refusal", async () => {
    const write = deferredRefusal();
    render(<NameCellInGridRow onCommit={write.onCommit} />);

    const field = openEditor();
    fireEvent.change(field, { target: { value: "never lands" } });
    fireEvent.keyDown(field, { key: "Enter" });
    const owningCell = gridCellOf(field);
    owningCell.focus();
    expect(owningCell).toHaveFocus();
    await act(() => write.refuse());

    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveAttribute("aria-invalid", "true");
  });

  it("leaves focus on another cell the user moved to before the refusal", async () => {
    const write = deferredRefusal();
    render(<NameCellInGridRow onCommit={write.onCommit} />);

    const field = openEditor();
    fireEvent.change(field, { target: { value: "never lands" } });
    fireEvent.keyDown(field, { key: "Enter" });
    const otherCell = gridCellOf(screen.getByText(OTHER_CELL_TEXT));
    otherCell.focus();
    expect(otherCell).toHaveFocus();
    await act(() => write.refuse());

    await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));
    expect(otherCell).toHaveFocus();
  });

  it("PRD-722 DT-062 clears a retained failure and collapses after returning to confirmation", async () => {
    const onCommit = vi.fn(() => Promise.reject(new Error("refused")));
    render(
      <InlineNameCell
        label={LABEL}
        onCommit={onCommit}
        renderValue={(shown) => <a href="#row">{shown}</a>}
        retainRejectedDraft
        saveErrorMessage="Couldn't save changes. Try again."
        value={NAME}
      />
    );

    const field = openEditor();
    fireEvent.change(field, { target: { value: "never lands" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));

    fireEvent.change(field, { target: { value: NAME } });
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
    field.blur();

    await waitFor(() =>
      expect(screen.getByRole("link", { name: NAME })).toBeInTheDocument()
    );
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("PRD-722 DT-035 keeps a newer refused name failed after an older acceptance", async () => {
    const settlers: {
      reject: (reason: unknown) => void;
      resolve: () => void;
    }[] = [];
    const onCommit = vi.fn<() => Promise<void>>(
      () =>
        new Promise<void>((resolve, reject) => {
          settlers.push({ reject, resolve });
        })
    );
    render(
      <InlineNameCell
        label={LABEL}
        onCommit={onCommit}
        renderValue={(shown) => <a href="#row">{shown}</a>}
        retainRejectedDraft
        saveErrorMessage="Couldn't save changes. Try again."
        value={NAME}
      />
    );

    const field = openEditor();
    fireEvent.change(field, { target: { value: "older name" } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.change(field, { target: { value: "newer name" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2));
    const [older, newer] = onCommit.mock.results.map((entry) => entry.value);

    settlers[1].reject(new Error("newer refused"));
    await newer.catch(() => undefined);
    settlers[0].resolve();
    await older;

    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveValue("newer name");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't save changes. Try again."
    );
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "older name" })
      ).toBeInTheDocument()
    );
  });

  it("PRD-722 DT-073 ignores an older retained-mode acceptance after the newer name is accepted", async () => {
    const settlers: { resolve: () => void }[] = [];
    const onCommit = vi.fn<() => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          settlers.push({ resolve });
        })
    );
    render(
      <InlineNameCell
        label={LABEL}
        onCommit={onCommit}
        renderValue={(shown) => <a href="#row">{shown}</a>}
        retainRejectedDraft
        saveErrorMessage="Couldn't save changes. Try again."
        value={NAME}
      />
    );

    const field = openEditor();
    fireEvent.change(field, { target: { value: "older name" } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.change(field, { target: { value: "newer name" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2));
    const [older, newer] = onCommit.mock.results.map((entry) => entry.value);

    settlers[1].resolve();
    await newer;
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "newer name" })
      ).toBeInTheDocument()
    );

    settlers[0].resolve();
    await older;
    expect(
      screen.getByRole("link", { name: "newer name" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "older name" })).toBeNull();
  });

  it("keeps retained-mode typing entered after Enter and commits it over the accepted name", async () => {
    let acceptFirst: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      acceptFirst = resolve;
    });
    const onCommit = vi
      .fn<
        (next: string, expected: string, owner?: () => boolean) => Promise<void>
      >()
      .mockImplementationOnce(() => firstWrite)
      .mockResolvedValueOnce();
    render(
      <InlineNameCell
        label={LABEL}
        onCommit={onCommit}
        renderValue={(shown) => <a href="#row">{shown}</a>}
        retainRejectedDraft
        saveErrorMessage="Couldn't save changes. Try again."
        value={NAME}
      />
    );

    const field = openEditor();
    fireEvent.change(field, { target: { value: "first rename" } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.change(field, { target: { value: "continued typing" } });

    await act(async () => {
      acceptFirst?.();
      await firstWrite;
    });

    expect(screen.getByRole("textbox", { name: LABEL })).toHaveValue(
      "continued typing"
    );
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2));
    expect(onCommit).toHaveBeenNthCalledWith(
      1,
      "first rename",
      NAME,
      expect.any(Function)
    );
    expect(onCommit).toHaveBeenNthCalledWith(
      2,
      "continued typing",
      "first rename",
      expect.any(Function)
    );
  });

  it("PRD-722 DT-074 clears the retained interlock through blank cancel and a later blur", async () => {
    const onCommit = vi.fn(() => Promise.reject(new Error("refused")));
    render(
      <InlineNameCell
        label={LABEL}
        onCommit={onCommit}
        renderValue={(shown) => <a href="#row">{shown}</a>}
        retainRejectedDraft
        saveErrorMessage="Couldn't save changes. Try again."
        value={NAME}
      />
    );

    const field = openEditor();
    fireEvent.change(field, { target: { value: "never lands" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));

    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByRole("link", { name: NAME })).toBeInTheDocument()
    );

    const reopened = openEditor<HTMLInputElement>();
    reopened.blur();
    await waitFor(() =>
      expect(screen.getByRole("link", { name: NAME })).toBeInTheDocument()
    );
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("collapses on Escape and writes nothing", async () => {
    const onCommit = vi.fn();
    render(
      <InlineNameCell
        label={LABEL}
        onCommit={onCommit}
        renderValue={(shown) => <a href="#row">{shown}</a>}
        value={NAME}
      />
    );

    const field = openEditor();
    fireEvent.change(field, { target: { value: "discarded" } });
    fireEvent.keyDown(field, { key: "Escape" });

    expect(onCommit).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("link", { name: NAME })).toBeInTheDocument()
    );
  });

  it("collapses on a blur that commits nothing, which onCommit cannot report", async () => {
    // The cell early-returns for an unchanged draft without calling `onCommit`,
    // so the editor would stay open forever on a focus-through if closing were
    // keyed on the commit.
    const onCommit = vi.fn();
    render(
      <InlineNameCell
        label={LABEL}
        onCommit={onCommit}
        renderValue={(shown) => <a href="#row">{shown}</a>}
        value={NAME}
      />
    );

    const field = openEditor();
    fireEvent.blur(field);

    expect(onCommit).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("link", { name: NAME })).toBeInTheDocument()
    );
  });

  it("declares the edit control as the cell's grid entry target", () => {
    // A lead cell holds the row link AND this control; without the marker a grid
    // entry key lands on whichever comes first in the DOM, which is the link.
    render(
      <InlineNameCell
        label={LABEL}
        onCommit={vi.fn()}
        renderValue={(shown) => <a href="#row">{shown}</a>}
        value={NAME}
      />
    );

    const control = screen.getByRole("button", { name: LABEL });
    expect(control).toHaveAttribute("data-grid-primary-editor");
    expect(
      control.parentElement?.querySelectorAll("[data-grid-primary-editor]")
    ).toHaveLength(1);
  });

  it("keeps a host's later value when the user has committed nothing", async () => {
    function Host() {
      const [value, setValue] = useState(NAME);
      return (
        <>
          <button onClick={() => setValue("from the server")} type="button">
            push
          </button>
          <InlineNameCell
            label={LABEL}
            onCommit={vi.fn()}
            renderValue={(shown) => <a href="#row">{shown}</a>}
            value={value}
          />
        </>
      );
    }
    render(<Host />);

    fireEvent.click(screen.getByRole("button", { name: "push" }));

    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "from the server" })
      ).toBeInTheDocument()
    );
  });
});

/**
 * ISS-11865 (#8312) landed row range-drag selection that suppresses text
 * selection FROM THE PRESS: an unmodified pointer press inside a grid row
 * `preventDefault()`s, clears any painted selection, and moves focus to the
 * pressed cell. This cell's pencil mounts a field that focuses and SELECTS its
 * value, so the two could fight — these cases execute the interaction rather
 * than relying on the press guard's wording.
 *
 * The guard is `INTERACTIVE_CELL_CONTENT_SELECTOR`, which lists `button` and
 * `input`, so a press on the pencil or inside the open field returns before any
 * suppression runs. That is what the assertions below pin.
 */
describe("InlineNameCell inside a range-drag grid", () => {
  const rowSelections: string[][] = [];

  function GridHost() {
    const [name, setName] = useState(NAME);
    return (
      <GridTableV2<{ id: string }>
        columns={[{ id: "status", label: "Status" }]}
        enableRowRangeDrag
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={[{ id: "row-0" }]}
        leadingLabel="Name"
        onRowClick={(row) => rowSelections.push([row.id])}
        onRowRangeDrag={(row) => rowSelections.push([row.id])}
        renderCell={() => <span>status</span>}
        renderLead={() => (
          <InlineNameCell
            label={LABEL}
            onCommit={(next) => setName(next)}
            renderValue={(shown) => <a href="#lead">{shown}</a>}
            value={name}
          />
        )}
      />
    );
  }

  it("opens the field focused and fully selected from a real pointer press", () => {
    rowSelections.length = 0;
    render(<GridHost />);

    const control = screen.getByRole("button", { name: LABEL });
    // A real press, not just a click: the suppression #8312 added runs on
    // `pointerdown`, so a click-only test would never reach it.
    fireEvent.pointerDown(control, { button: 0, pointerType: "mouse" });
    fireEvent.click(control);

    const field = screen.getByRole<HTMLInputElement>("textbox", {
      name: LABEL,
    });
    expect(field).toHaveFocus();
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(NAME.length);
    // The press belongs to the editor, not to the row.
    expect(rowSelections).toEqual([]);
  });

  it("keeps the field focused when the user presses inside it", () => {
    rowSelections.length = 0;
    render(<GridHost />);

    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    const field = screen.getByRole<HTMLInputElement>("textbox", {
      name: LABEL,
    });

    // `focusCellFromRowClick` would move focus to the gridcell and the editor
    // would lose it mid-edit; the press guard is what stops that.
    fireEvent.pointerDown(field, { button: 0, pointerType: "mouse" });

    expect(field).toHaveFocus();
    expect(screen.getByRole("textbox", { name: LABEL })).toBeInTheDocument();
    expect(rowSelections).toEqual([]);
  });

  it("still commits from inside the grid, and shows the committed name", async () => {
    rowSelections.length = 0;
    render(<GridHost />);

    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    const field = screen.getByRole("textbox", { name: LABEL });
    fireEvent.change(field, { target: { value: "renamed in a grid" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "renamed in a grid" })
      ).toBeInTheDocument()
    );
  });
});

function NameCellInGridRow({
  onCommit,
}: Readonly<{ onCommit: () => Promise<unknown> }>) {
  return (
    <GridTableV2<{ id: string }>
      columns={[{ id: "other", label: "Other" }]}
      getRowId={(row) => row.id}
      gridTemplateColumns="200px 120px"
      items={[{ id: "row-0" }]}
      leadingLabel="Name"
      renderCell={() => <span>{OTHER_CELL_TEXT}</span>}
      renderLead={() => (
        <InlineNameCell
          label={LABEL}
          onCommit={onCommit}
          renderValue={(shown) => <a href="#row">{shown}</a>}
          retainRejectedDraft
          saveErrorMessage="Couldn't save changes. Try again."
          value={NAME}
        />
      )}
    />
  );
}

const OTHER_CELL_TEXT = "Other value";

/** A write the test refuses on cue, after it has moved focus. */
function deferredRefusal() {
  let reject: ((reason: Error) => void) | undefined;
  const pending = new Promise<unknown>((_resolve, rejectWrite) => {
    reject = rejectWrite;
  });
  return {
    onCommit: () => pending,
    refuse: async () => {
      reject?.(new Error("refused"));
      await pending.catch(() => undefined);
    },
  };
}
