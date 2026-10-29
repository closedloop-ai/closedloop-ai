/**
 * Fallback arms inside the table-grid header stories' `render` functions.
 *
 * Each story reads its Controls args with `??` / `||` and falls back to a
 * local default when Controls clears one. The stories' own `play`s always run
 * with the arg filled in, so the fallback side never executes. These cases
 * clear the arg, drop the `play`, and assert the default shows up in the DOM.
 * Expected values are written out, not imported from the stories, so a changed
 * default fails here.
 */
import { composeStory } from "@storybook/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import headerV2Meta, {
  Default as headerV2DefaultStory,
} from "../stories/table-grid-header-v2.stories";

const DEFAULT_GRID_TEMPLATE = "280px repeat(3, 180px)";
const DEFAULT_LEADING_LABEL = "Name";

function withoutPlay<T extends object>(story: T): T {
  return { ...story, play: undefined };
}

describe("table-grid-header-v2 Default with cleared template and leading label", () => {
  it("falls back to the default grid template and the Name lead header", () => {
    const Story = composeStory(withoutPlay(headerV2DefaultStory), headerV2Meta);
    render(<Story gridTemplateColumns="" leadingLabel="" />);

    const lead = screen.getAllByRole("columnheader")[0];
    expect(lead).toHaveTextContent(DEFAULT_LEADING_LABEL);
    const templated = document.body.querySelector<HTMLElement>(
      "[style*='grid-template-columns']"
    );
    expect(templated?.style.gridTemplateColumns).toBe(DEFAULT_GRID_TEMPLATE);
  });
});
