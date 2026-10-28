/**
 * Behavior test for the Table Cell Primitives demo's favorite cell.
 *
 * The cell is the one control in that story with state behind it, and its
 * handler picks the announced action from the value it was handed. The sweep
 * mounts the story without pressing anything, so neither arm of that choice is
 * taken. Both are driven here, and the announcement is read off the live region
 * the story renders for a screen reader rather than off the handler.
 */
import { composeStory } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { describe, expect, it } from "vitest";
import tableCellPrimitivesMeta, {
  TypeMatrix as typeMatrixStory,
} from "../stories/table-cell-primitives.stories";

const TypeMatrix = composeStory(typeMatrixStory, tableCellPrimitivesMeta);

const FAVORITE_ITEM_LABEL = "Generic artifact UX";
const ADD_FAVORITE_LABEL = `Add ${FAVORITE_ITEM_LABEL} to favorites`;
const REMOVE_FAVORITE_LABEL = `Remove ${FAVORITE_ITEM_LABEL} from favorites`;

/** The text the story's polite live region is currently announcing. */
function announcedAction(): string {
  const region = document.body.querySelector('[aria-live="polite"]');
  if (!region) {
    throw new Error("the story rendered no live region");
  }
  return region.textContent ?? "";
}

function favoriteControl(label: string): HTMLElement {
  return within(document.body).getByRole("button", { name: label });
}

describe("table cell primitives favorite cell", () => {
  it("announces favoriting and unfavoriting as different actions", async () => {
    await TypeMatrix.run();
    const before = announcedAction();

    // The control's own label is the second reading of the same state, so a
    // handler that announced the right words while leaving the cell unpressed
    // would still fail here.
    await userEvent.click(favoriteControl(ADD_FAVORITE_LABEL));
    expect(announcedAction()).toBe("Favorited row");
    expect(announcedAction()).not.toBe(before);
    expect(
      favoriteControl(REMOVE_FAVORITE_LABEL).getAttribute("aria-pressed")
    ).toBe("true");

    await userEvent.click(favoriteControl(REMOVE_FAVORITE_LABEL));
    expect(announcedAction()).toBe("Unfavorited row");
    expect(
      favoriteControl(ADD_FAVORITE_LABEL).getAttribute("aria-pressed")
    ).toBe("false");
  });
});
