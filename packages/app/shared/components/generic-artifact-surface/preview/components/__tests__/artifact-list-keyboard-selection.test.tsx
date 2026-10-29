// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectionSentence } from "../../../bulk-action-bar";
import { genericArtifacts } from "../../fixtures";
import { GenericArtifactListShell } from "../artifact-shells";

const artifacts = [
  genericArtifacts[1],
  genericArtifacts[0],
  genericArtifacts[2],
  genericArtifacts[4],
].map((artifact) => ({ ...artifact, updatedAgoMinutes: 0 }));
const IN_PROGRESS_GROUP = /^In progress\s*1$/;

function row(slug: string): HTMLElement {
  const element = screen
    .getByText(slug)
    .closest<HTMLElement>("[data-grid-row]");
  if (!element) {
    throw new Error(`Missing row ${slug}`);
  }
  return element;
}

function cell(slug: string): HTMLElement {
  const element =
    row(slug).querySelectorAll<HTMLElement>("[data-grid-cell]")[1];
  if (!element) {
    throw new Error(`Missing identity cell for ${slug}`);
  }
  return element;
}

function selectedSlugs(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[data-grid-row][aria-selected="true"]'
    ),
  ].map((selected) => selected.textContent ?? "");
}

describe("generic artifact list keyboard selection", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("extends Shift+Space through rendered group order, toggles with Space, and clears with Escape", () => {
    render(
      <GenericArtifactListShell
        artifacts={artifacts}
        defaultGroupBy="status"
        onOpenArtifact={vi.fn()}
        showSummaryCards={false}
        variant="embedded"
      />
    );

    fireEvent.click(cell("ISS-4382"));
    const inReviewCell = cell("FEA-2481");
    act(() => inReviewCell.focus());
    fireEvent.keyDown(inReviewCell, { key: " ", shiftKey: true });

    expect(row("ISS-4382").getAttribute("aria-selected")).toBe("true");
    expect(row("SES-7B91").getAttribute("aria-selected")).toBe("true");
    expect(row("FEA-2481").getAttribute("aria-selected")).toBe("true");
    expect(row("DOC-184").getAttribute("aria-selected")).toBe("false");
    expect(
      screen.getByRole("toolbar", { name: selectionSentence(3) })
    ).toBeTruthy();

    fireEvent.keyDown(inReviewCell, { key: " " });
    expect(row("FEA-2481").getAttribute("aria-selected")).toBe("false");
    expect(
      screen.getByRole("toolbar", { name: selectionSentence(2) })
    ).toBeTruthy();

    fireEvent.keyDown(inReviewCell, { key: "Escape" });
    expect(selectedSlugs()).toEqual([]);
    expect(screen.queryByText(selectionSentence(2))).toBeNull();
  });

  it("selects only rendered rows with Cmd/Ctrl+A and keeps bulk actions keyboard-reachable", () => {
    render(
      <GenericArtifactListShell
        artifacts={artifacts}
        defaultGroupBy="status"
        onOpenArtifact={vi.fn()}
        showSummaryCards={false}
        variant="embedded"
      />
    );

    const todoCell = cell("ISS-4382");
    act(() => todoCell.focus());
    fireEvent.keyDown(todoCell, { key: "a", metaKey: true });
    expect(selectedSlugs()).toHaveLength(4);
    expect(
      screen.getByRole("toolbar", { name: selectionSentence(4) })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Favorite" })).toBeTruthy();

    fireEvent.keyDown(todoCell, { key: "Escape" });
    expect(selectedSlugs()).toEqual([]);
    fireEvent.keyDown(todoCell, { key: "a", ctrlKey: true });
    expect(selectedSlugs()).toHaveLength(4);
  });

  it("extends a Shift+Arrow range across a group boundary", () => {
    render(
      <GenericArtifactListShell
        artifacts={artifacts}
        defaultGroupBy="status"
        onOpenArtifact={vi.fn()}
        showSummaryCards={false}
        variant="embedded"
      />
    );

    const todoCell = cell("ISS-4382");
    fireEvent.click(todoCell);
    act(() => todoCell.focus());
    fireEvent.keyDown(todoCell, { key: "ArrowDown", shiftKey: true });
    expect(row("ISS-4382").getAttribute("aria-selected")).toBe("true");
    expect(row("SES-7B91").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(cell("SES-7B91"));
  });

  it("excludes collapsed-group rows from select-all and Shift+Space ranges", () => {
    render(
      <GenericArtifactListShell
        artifacts={artifacts}
        defaultGroupBy="status"
        onOpenArtifact={vi.fn()}
        showSummaryCards={false}
        variant="embedded"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: IN_PROGRESS_GROUP }));
    expect(screen.queryByText("SES-7B91")).toBeNull();

    const todoCell = cell("ISS-4382");
    act(() => todoCell.focus());
    fireEvent.keyDown(todoCell, { key: "a", ctrlKey: true });
    expect(selectedSlugs()).toHaveLength(3);

    fireEvent.keyDown(todoCell, { key: "Escape" });
    fireEvent.click(todoCell);
    const doneCell = cell("DOC-184");
    act(() => doneCell.focus());
    fireEvent.keyDown(doneCell, { key: " ", shiftKey: true });
    expect(row("ISS-4382").getAttribute("aria-selected")).toBe("true");
    expect(row("FEA-2481").getAttribute("aria-selected")).toBe("true");
    expect(row("DOC-184").getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByRole("toolbar", { name: selectionSentence(3) })
    ).toBeTruthy();
  });
});
