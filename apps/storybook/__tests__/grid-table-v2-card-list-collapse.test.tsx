/**
 * Behavior tests for the collapse state `CardListStory`
 * (`stories/grid-table-v2-card-list.stories.tsx`) owns.
 *
 * Both of that file's plays stop one step into a round trip: `Grouped`
 * collapses a band and never reopens it, and `NestedRows` expands a row and
 * never closes it. So each toggle's REMOVAL arm — the `delete` half of the
 * `Set` both handlers rebuild — was never reached, and a handler that only
 * ever added would pass every existing assertion while making the control
 * one-way.
 *
 * The disclosure renames itself as it flips, so each step re-queries by the
 * name the control carries in the state it is now in.
 */
import { composeStory } from "@storybook/react";
import { screen } from "@testing-library/react";
import { userEvent } from "storybook/test";
import { describe, expect, it } from "vitest";
import frozenGridMeta, {
  NestedRowsCompactContract as frozenNestedRowsCompactStory,
} from "../stories/grid-table-v2.stories";
import cardListMeta, {
  Grouped as groupedStory,
  NestedRows as nestedRowsStory,
} from "../stories/grid-table-v2-card-list.stories";
import { renderStoryWithoutPlay } from "./helpers/compose-story-without-play";

const ACTIVE_PATTERN = /Active/;
const CHILD_TITLE = "Alpha child";
const EXPAND_ROW = "Expand row";
const COLLAPSE_ROW = "Collapse row";

describe("GridTableV2 card list collapse round trips", () => {
  it("keeps the frozen v1 nested-card disclosure outside the card", async () => {
    const Story = composeStory(frozenNestedRowsCompactStory, frozenGridMeta);
    await Story.run();

    const disclosure = screen.getByRole("button", { name: EXPAND_ROW });
    expect(disclosure.closest('[data-slot="card"]')).toBeNull();
    expect(
      disclosure.parentElement?.querySelector('[data-slot="card"]')
    ).not.toBeNull();
  });

  it("reopens a collapsed band and brings its cards back", async () => {
    const canvas = await renderStoryWithoutPlay(groupedStory, cardListMeta);
    expect(
      canvas.getByRole("button", { name: ACTIVE_PATTERN })
    ).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(canvas.getByRole("button", { name: ACTIVE_PATTERN }));
    expect(
      canvas.getByRole("button", { name: ACTIVE_PATTERN })
    ).toHaveAttribute("aria-expanded", "false");
    expect(canvas.queryByText("Alpha")).toBeNull();

    // The removal arm: collapsing twice has to REOPEN the band, not keep it
    // shut. The cards coming back is the proof the key left the set.
    await userEvent.click(canvas.getByRole("button", { name: ACTIVE_PATTERN }));
    expect(
      canvas.getByRole("button", { name: ACTIVE_PATTERN })
    ).toHaveAttribute("aria-expanded", "true");
    expect(canvas.getByText("Alpha")).toBeInTheDocument();
  });

  it("collapses an expanded nested row and drops its child again", async () => {
    const canvas = await renderStoryWithoutPlay(nestedRowsStory, cardListMeta);

    await userEvent.click(canvas.getByRole("button", { name: EXPAND_ROW }));
    expect(canvas.getByText(CHILD_TITLE)).toBeInTheDocument();

    // The removal arm: the child is GONE, not merely hidden, so a handler that
    // never deleted the row id would fail here.
    await userEvent.click(canvas.getByRole("button", { name: COLLAPSE_ROW }));
    expect(canvas.getByRole("button", { name: EXPAND_ROW })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(canvas.queryByText(CHILD_TITLE)).toBeNull();
  });
});
