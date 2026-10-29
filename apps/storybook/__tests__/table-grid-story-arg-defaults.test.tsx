/**
 * The resize-handle stories fall back to their own default label when
 * Controls clears the `label` arg. The stories' own `play`s always run with
 * the arg filled in, so these cases render each story with it removed and
 * assert the fallback label is what the handle's accessible name reports.
 * `columnId` is left set: no rendered output depends on its value, so a test
 * clearing it could not tell its fallback apart from any other id.
 */
import { composeStory } from "@storybook/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import handlesMeta, {
  AtMinimumWidth as atMinimumWidthStory,
  CorruptPersistedWidth as corruptPersistedWidthStory,
  KeyboardResize as keyboardResizeStory,
} from "../stories/table-grid-header-v2-handles.stories";

/** Written out rather than derived from the stories' private constants. */
const DEFAULT_LABEL = "Status";
const START_WIDTH_PX = 180;
const MIN_WIDTH_NAME_PATTERN = new RegExp(
  `^Resize ${DEFAULT_LABEL} column, \\d+ pixels wide, minimum, use arrow keys$`
);

function withoutPlay<T extends object>(story: T): T {
  return { ...story, play: undefined };
}

describe("resize-handle stories with cleared args", () => {
  const clearedArgs = { label: undefined };

  it("KeyboardResize falls back to the default column label", () => {
    const Story = composeStory(withoutPlay(keyboardResizeStory), handlesMeta);
    render(<Story {...clearedArgs} />);
    expect(
      screen.getByRole("button", {
        name: `Resize ${DEFAULT_LABEL} column, ${START_WIDTH_PX} pixels wide, use arrow keys`,
      })
    ).toBeInTheDocument();
  });

  it("AtMinimumWidth falls back to the default column label", () => {
    const Story = composeStory(withoutPlay(atMinimumWidthStory), handlesMeta);
    render(<Story {...clearedArgs} />);
    expect(
      screen.getByRole("button", { name: MIN_WIDTH_NAME_PATTERN })
    ).toBeInTheDocument();
  });

  it("CorruptPersistedWidth falls back to the default column label", () => {
    const Story = composeStory(
      withoutPlay(corruptPersistedWidthStory),
      handlesMeta
    );
    render(<Story {...clearedArgs} />);
    expect(
      screen.getByRole("button", {
        name: `Resize ${DEFAULT_LABEL} column, use arrow keys`,
      })
    ).toBeInTheDocument();
  });
});
