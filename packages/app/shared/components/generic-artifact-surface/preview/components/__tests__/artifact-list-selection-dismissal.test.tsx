// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { genericArtifacts } from "../../fixtures";
import { GenericArtifactListShell } from "../artifact-shells";

const artifacts = [
  genericArtifacts[1],
  genericArtifacts[0],
  genericArtifacts[2],
  genericArtifacts[4],
].map((artifact) => ({ ...artifact, updatedAgoMinutes: 0 }));

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

function isSelected(slug: string): boolean {
  return row(slug).getAttribute("aria-selected") === "true";
}

function selectTwo() {
  fireEvent.click(cell("ISS-4382"));
  fireEvent.click(cell("DOC-184"), { metaKey: true });
  return [isSelected("ISS-4382"), isSelected("DOC-184")];
}

describe("generic artifact list selection dismissal", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    render(
      <GenericArtifactListShell
        artifacts={artifacts}
        defaultGroupBy="status"
        onOpenArtifact={vi.fn()}
        showSummaryCards={false}
        variant="embedded"
      />
    );
  });

  it("keeps the set for bulk-toolbar, modifier, and non-primary pointer actions", () => {
    expect(selectTwo()).toEqual([true, true]);

    fireEvent.pointerDown(
      screen.getByRole("toolbar", { name: "2 artifacts selected" }),
      { button: 0 }
    );
    fireEvent.pointerDown(document.body, { button: 0, shiftKey: true });
    fireEvent.pointerDown(document.body, { button: 0, metaKey: true });
    fireEvent.pointerDown(document.body, { button: 2 });

    expect(isSelected("ISS-4382")).toBe(true);
    expect(isSelected("DOC-184")).toBe(true);
  });

  it("keeps the set while a portaled bulk picker is used", () => {
    expect(selectTwo()).toEqual([true, true]);

    fireEvent.click(screen.getByRole("button", { name: "Change status" }));
    fireEvent.pointerDown(screen.getByRole("dialog"), { button: 0 });

    expect(isSelected("ISS-4382")).toBe(true);
    expect(isSelected("DOC-184")).toBe(true);
  });

  it("lets an ordinary row click replace the cleared set with its own row", () => {
    expect(selectTwo()).toEqual([true, true]);

    fireEvent.pointerDown(cell("ISS-4382"), { button: 0 });
    fireEvent.click(cell("ISS-4382"));

    expect(isSelected("ISS-4382")).toBe(true);
    expect(isSelected("DOC-184")).toBe(false);
  });

  it("clears the set on an ordinary primary pointer-down outside it", () => {
    expect(selectTwo()).toEqual([true, true]);

    fireEvent.pointerDown(document.body, { button: 0 });

    expect(isSelected("ISS-4382")).toBe(false);
    expect(isSelected("DOC-184")).toBe(false);
    expect(
      screen.queryByRole("toolbar", { name: "2 artifacts selected" })
    ).toBeNull();
  });
});
