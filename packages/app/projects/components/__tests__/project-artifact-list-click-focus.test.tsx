import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  mountProjectArtifactList as mount,
  projectArtifactListMocks,
  resetProjectArtifactListMocks,
} from "./support/project-artifact-list-live-harness";

const mocks = projectArtifactListMocks();

beforeEach(resetProjectArtifactListMocks);

const selectedRowCount = () =>
  document.querySelectorAll('[data-grid-row][aria-selected="true"]').length;

describe("Project Detail grouped grid keyboard selection after a click (ISS-13007)", () => {
  it("keeps focus in the grid after a click selects a row, so Ctrl+A selects all and Escape clears", async () => {
    mocks.flagEnabled = false;
    mocks.realView = true;
    mount("group=status");

    await waitFor(() =>
      expect(
        document.querySelectorAll("[data-grid-row][data-grid-row-id]").length
      ).toBeGreaterThan(1)
    );
    const dataRowIds = Array.from(
      document.querySelectorAll("[data-grid-selectable-row], [aria-selected]")
    ).length;
    const cell = document.querySelector<HTMLElement>(
      "[data-grid-row-id] [data-grid-cell]"
    ) as HTMLElement;

    fireEvent.click(cell);
    expect(selectedRowCount()).toBe(1);
    expect(
      screen.getAllByRole("grid")[0]?.contains(document.activeElement)
    ).toBe(true);

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      ctrlKey: true,
      key: "a",
    });
    expect(selectedRowCount()).toBe(dataRowIds);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(selectedRowCount()).toBe(0);
  });
});
