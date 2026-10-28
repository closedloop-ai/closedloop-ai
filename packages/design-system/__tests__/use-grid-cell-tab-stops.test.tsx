import { useGridCellTabStops } from "@closedloop-ai/design-system/hooks/use-grid-cell-tab-stops";
import { GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE } from "@closedloop-ai/design-system/lib/grid-cell-tab-stops";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

function Probe({ enabled }: { enabled: boolean }) {
  const ref = useGridCellTabStops(enabled);
  return (
    <div data-testid="grid-body" ref={ref}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: models GridTableV2's roving tabindex, which lives outside this hook */}
      <div data-grid-cell="" tabIndex={0}>
        <button data-testid="btn" type="button">
          click
        </button>
        <a data-testid="link" href="/somewhere">
          somewhere
        </a>
      </div>
    </div>
  );
}

describe("useGridCellTabStops", () => {
  it("suppresses a cell control's tab stop when enabled", () => {
    render(<Probe enabled />);

    const button = screen.getByTestId("btn");
    expect(button).toHaveAttribute("tabindex", "-1");
    expect(button).toHaveAttribute(GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE, "");
  });

  it("attaches nothing when disabled, leaving the DOM exactly as it was", () => {
    render(<Probe enabled={false} />);

    const button = screen.getByTestId("btn");
    expect(button).not.toHaveAttribute("tabindex");
    expect(button).not.toHaveAttribute(GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE);
  });

  it("does not suppress the grid's own roving cell, only its content", () => {
    render(<Probe enabled />);

    const cell = document.querySelector("[data-grid-cell]");
    expect(cell).toHaveAttribute("tabindex", "0");
    expect(cell).not.toHaveAttribute(GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE);
  });

  it("suppresses every enterable control in the grid body, not just the first", () => {
    render(<Probe enabled />);

    expect(screen.getByTestId("btn")).toHaveAttribute("tabindex", "-1");
    expect(screen.getByTestId("link")).toHaveAttribute("tabindex", "-1");
  });

  it("releases the suppression when the grid body is unmounted", () => {
    const { unmount } = render(<Probe enabled />);
    // Held across the unmount: asserting only that unmount does not throw stays
    // green with `dispose`'s `release(gridBody)` deleted, because nothing then
    // looks at what the controls were left holding.
    const button = screen.getByTestId("btn");
    expect(button).toHaveAttribute("tabindex", "-1");
    expect(button).toHaveAttribute(GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE);

    unmount();

    // The probe's button carried no `tabindex` of its own, so release removes
    // the attribute outright rather than restoring a value.
    expect(button).not.toHaveAttribute("tabindex");
    expect(button).not.toHaveAttribute(GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE);
  });

  it("re-suppresses controls added to the grid body after the initial attach", async () => {
    render(<Probe enabled />);
    const gridBody = screen.getByTestId("grid-body");

    const newCell = document.createElement("div");
    newCell.setAttribute("data-grid-cell", "");
    const newButton = document.createElement("button");
    newButton.type = "button";
    newButton.textContent = "late";
    newCell.appendChild(newButton);
    gridBody.appendChild(newCell);

    // The MutationObserver callback runs as a microtask.
    await Promise.resolve();
    await Promise.resolve();

    expect(newButton).toHaveAttribute("tabindex", "-1");
  });

  it("does not throw when the ref callback is invoked with null before any node was attached", () => {
    function EarlyDetach({ show }: { show: boolean }) {
      const ref = useGridCellTabStops(true);
      return show ? <div ref={ref} /> : null;
    }

    const { rerender } = render(<EarlyDetach show={false} />);
    expect(() => rerender(<EarlyDetach show />)).not.toThrow();
    expect(() => rerender(<EarlyDetach show={false} />)).not.toThrow();
  });
});
