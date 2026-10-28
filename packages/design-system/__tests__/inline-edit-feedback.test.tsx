import { GridTableV2 } from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import {
  InlineEditFeedback,
  refocusInlineEditControlIfOwned,
} from "@closedloop-ai/design-system/components/ui/inline-edit-feedback";
import { gridCellOf } from "@closedloop-ai/design-system/test/grid-roving-tab-stop";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * PRD-722: the message an inline editor renders beside a refused or
 * unreadable draft, and the focus helper the editors share. The cells' own
 * suites cover when the message mounts; these cases pin what it is once it
 * does.
 */

const MESSAGE = "Sample save failure.";
const OTHER_MESSAGE = "Another sample failure.";

describe("InlineEditFeedback", () => {
  it("announces the host's message and carries the id a field points at", () => {
    render(
      <>
        <input aria-describedby="first" aria-label="First" />
        <InlineEditFeedback id="first" message={MESSAGE} />
        <input aria-describedby="second" aria-label="Second" />
        <InlineEditFeedback id="second" message={OTHER_MESSAGE} />
      </>
    );

    const alerts = screen.getAllByRole("alert");
    expect(alerts.map((alert) => alert.textContent)).toEqual([
      MESSAGE,
      OTHER_MESSAGE,
    ]);
    expect(
      screen.getByRole("textbox", { name: "First" })
    ).toHaveAccessibleDescription(MESSAGE);
    expect(
      screen.getByRole("textbox", { name: "Second" })
    ).toHaveAccessibleDescription(OTHER_MESSAGE);
  });

  it("sets its own weight so a heading host does not make it bold", () => {
    render(
      <h1 className="font-semibold">
        <InlineEditFeedback message={MESSAGE} />
      </h1>
    );

    expect(screen.getByRole("alert")).toHaveClass("font-normal");
  });

  it("returns the full sentence in a title only when it truncates", () => {
    render(
      <>
        <InlineEditFeedback message={MESSAGE} truncate />
        <InlineEditFeedback message={OTHER_MESSAGE} />
      </>
    );

    const [truncated, wrapping] = screen.getAllByRole("alert");
    expect(truncated).toHaveAttribute("title", MESSAGE);
    expect(truncated).toHaveClass("truncate");
    expect(wrapping).not.toHaveAttribute("title");
    expect(wrapping).not.toHaveClass("truncate");
  });

  it("follows a right-aligned field only when asked", () => {
    render(
      <>
        <InlineEditFeedback alignEnd message={MESSAGE} />
        <InlineEditFeedback message={OTHER_MESSAGE} />
      </>
    );

    const [aligned, start] = screen.getAllByRole("alert");
    expect(aligned).toHaveClass("text-right");
    expect(start).not.toHaveClass("text-right");
  });
});

describe("refocusInlineEditControlIfOwned", () => {
  it("does nothing without a control", () => {
    expect(refocusInlineEditControlIfOwned(null)).toBe(false);
  });

  it("restores focus when nothing else holds it", () => {
    render(<input aria-label="Field" />);
    const field = screen.getByRole("textbox", { name: "Field" });
    expect(document.activeElement).toBe(document.body);

    expect(refocusInlineEditControlIfOwned(field)).toBe(true);
    expect(document.activeElement).toBe(field);
  });

  it("keeps focus on the control that already has it", () => {
    render(<input aria-label="Field" />);
    const field = screen.getByRole("textbox", { name: "Field" });
    field.focus();

    expect(refocusInlineEditControlIfOwned(field)).toBe(true);
    expect(document.activeElement).toBe(field);
  });

  it("never pulls the user back from a different control", () => {
    render(
      <>
        <input aria-label="Field" />
        <input aria-label="Elsewhere" />
      </>
    );
    const field = screen.getByRole("textbox", { name: "Field" });
    const elsewhere = screen.getByRole("textbox", { name: "Elsewhere" });
    elsewhere.focus();

    expect(refocusInlineEditControlIfOwned(field)).toBe(false);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("restores focus from the grid cell that holds the control", () => {
    render(<GridWithField />);
    const field = screen.getByRole("textbox", { name: "Field" });
    const owningCell = gridCellOf(field);
    owningCell.focus();
    expect(document.activeElement).toBe(owningCell);

    expect(refocusInlineEditControlIfOwned(field)).toBe(true);
    expect(document.activeElement).toBe(field);
  });

  it("restores focus from the row that holds the control", () => {
    render(<GridWithField />);
    const field = screen.getByRole("textbox", { name: "Field" });
    const row = field.closest<HTMLElement>('[role="row"]');
    if (!row) {
      throw new Error("The field is not inside a grid row");
    }
    row.tabIndex = -1;
    row.focus();
    expect(document.activeElement).toBe(row);

    expect(refocusInlineEditControlIfOwned(field)).toBe(true);
    expect(document.activeElement).toBe(field);
  });

  it("leaves focus on a different cell of the same row", () => {
    render(<GridWithField />);
    const field = screen.getByRole("textbox", { name: "Field" });
    const otherCell = gridCellOf(screen.getByText(OTHER_CELL_TEXT));
    otherCell.focus();
    expect(document.activeElement).toBe(otherCell);

    expect(refocusInlineEditControlIfOwned(field)).toBe(false);
    expect(document.activeElement).toBe(otherCell);
  });
});

const OTHER_CELL_TEXT = "Other value";

function GridWithField() {
  return (
    <GridTableV2<{ id: string }>
      columns={[{ id: "other", label: "Other" }]}
      getRowId={(row) => row.id}
      gridTemplateColumns="200px 120px"
      items={[{ id: "row-0" }]}
      leadingLabel="Name"
      renderCell={() => <span>{OTHER_CELL_TEXT}</span>}
      renderLead={() => <input aria-label="Field" />}
    />
  );
}
