/**
 * ISS-8038 AC3, on the surface the ticket names: `TableFavoriteCell` rendered
 * through `renderLeadingUtility` in the Grid Table V2 parity demo.
 *
 * Favoriting is a control INSIDE a cell, which is exactly the case the APG
 * cell-entry model exists to cover. Before this, the leading utility cell was
 * not a navigable grid cell at all, so the star had no route through the grid —
 * the grid's own keys could not reach it and nothing defined what `Enter` on
 * that cell should do (WCAG 2.1.1).
 *
 * Driven through the real demo rather than a synthetic fixture, because the
 * design-system suite already covers the primitive and the gap this ticket
 * describes is that the demo's own composition dropped the keyboard surface.
 */

import { composeStory } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { describe, expect, it } from "vitest";
import { initialArtifactRows } from "../../../packages/app/shared/components/generic-artifact-surface/fixtures";
import { GenericArtifactTableDemo } from "../../../packages/app/shared/components/generic-artifact-surface/generic-artifact-table";

// The demo seeds `artifact-1` as the only favorited row, so this row's star
// starts pressed and the keyboard path un-favorites it.
const [favoritedArtifact] = initialArtifactRows;
const REMOVE_LABEL = `Remove ${favoritedArtifact.title} from favorites`;
const ADD_LABEL = `Add ${favoritedArtifact.title} to favorites`;

function renderDemo() {
  return composeStory(
    { render: () => <GenericArtifactTableDemo initialFields={[]} /> },
    {
      title: "Test/GenericArtifactTableDemo",
      component: GenericArtifactTableDemo,
    }
  );
}

describe("Grid Table V2 parity demo — favoriting from the keyboard", () => {
  it("reaches the star through the cell-entry model and toggles it", async () => {
    const Story = renderDemo();
    await Story.run();
    const screen = within(document.body);

    const star = screen.getByRole("button", { name: REMOVE_LABEL });
    const utilityCell = star.closest<HTMLElement>("[data-grid-cell]");
    // The cell holding the control has to BE a navigable grid cell, or there is
    // no keyboard route to the control inside it.
    expect(utilityCell).not.toBeNull();

    (utilityCell as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    expect(star).toHaveFocus();

    await userEvent.keyboard("{Enter}");

    expect(screen.getByRole("button", { name: ADD_LABEL })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("walks the row's cells with Home and End", async () => {
    const Story = renderDemo();
    await Story.run();
    const screen = within(document.body);

    const star = screen.getByRole("button", { name: REMOVE_LABEL });
    const row = star.closest<HTMLElement>("[data-grid-row]");
    const cells = Array.from(
      (row as HTMLElement).querySelectorAll<HTMLElement>("[data-grid-cell]")
    );
    const middle = cells[2];
    (middle as HTMLElement).focus();

    await userEvent.keyboard("{End}");
    expect(cells.at(-1)).toHaveFocus();

    await userEvent.keyboard("{Home}");
    // Home lands on the row's FIRST cell, which is the utility cell holding the
    // star — the same cell the entry-model case above operates.
    expect(cells[0]).toHaveFocus();
    expect(cells[0]?.contains(star)).toBe(true);
  });
});
