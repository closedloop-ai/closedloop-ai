/**
 * Behavior tests for the select-all state `HeaderStory`
 * (`stories/table-grid-header-v2.stories.tsx`) owns.
 *
 * `SelectAllStates`' own `play` drives the demo's Some/All buttons, which set
 * the local count directly. So two things it never touches: the round trip
 * through the header's OWN checkbox (`onSelectAll`), and the two arg-seeded
 * initial states that `resolveInitialSelectedCount` maps onto that count.
 *
 * Asserted on `aria-checked` — the tri-state assistive tech actually reports,
 * and the same vocabulary the story's `play` uses, so a state that only ever
 * reached `data-state` cannot satisfy these.
 */
import { userEvent } from "storybook/test";
import { describe, expect, it } from "vitest";
import headerMeta, {
  SelectAllStates as selectAllStory,
} from "../stories/table-grid-header-v2.stories";
import { renderStoryWithoutPlay } from "./helpers/compose-story-without-play";

type StoryArgs = Partial<typeof selectAllStory.args>;

function renderHeader(extraArgs: StoryArgs = {}) {
  return renderStoryWithoutPlay(
    { ...selectAllStory, args: { ...selectAllStory.args, ...extraArgs } },
    headerMeta
  );
}

describe("TableGridHeaderV2 select-all", () => {
  it("toggles the whole selection on and back off through the header checkbox", async () => {
    const canvas = await renderHeader();
    const checkbox = canvas.getByRole("checkbox");
    expect(checkbox).toHaveAttribute("aria-checked", "false");

    await userEvent.click(checkbox);
    expect(canvas.getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "true"
    );

    // The un-check half: `onSelectAll(false)` has to return the count to zero
    // rather than leave it at the total, which would strand the control
    // checked over a selection the user just cleared.
    await userEvent.click(canvas.getByRole("checkbox"));
    expect(canvas.getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "false"
    );
  });

  it("seeds a fully-selected count from the allSelected arg", async () => {
    const canvas = await renderHeader({ allSelected: true });
    expect(canvas.getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "true"
    );
  });

  it("seeds a partial count from the someSelected arg and announces mixed", async () => {
    const canvas = await renderHeader({ someSelected: true });
    expect(canvas.getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "mixed"
    );
  });
});
