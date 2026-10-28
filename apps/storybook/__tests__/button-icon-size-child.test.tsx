/**
 * ISS-10237 — the icon-size child swap, held against the args a viewer can
 * actually reach.
 *
 * The sweep runs every Button story with `meta.args` applied, so it only ever
 * sees `size: "default"` and the swap never fires there. Each case below
 * composes a story against a meta whose `size` is an icon size, which is what
 * picking one in the Storybook control leaves behind — the exact state the
 * clipped-label bug lived in.
 */
import { composeStory } from "@storybook/react";
import { within } from "storybook/test";
import { describe, expect, it } from "vitest";
import buttonMeta, {
  Default as defaultStory,
  Disabled as disabledStory,
  Outline as outlineStory,
} from "../stories/button.stories";

const DEFAULT_LABEL = "Button";
const TYPED_LABEL = "Save changes";

/** The meta as it stands after a viewer picks an icon size in the control. */
function metaAtSize(size: string, children?: string) {
  return {
    ...buttonMeta,
    args: { ...buttonMeta.args, size, ...(children ? { children } : {}) },
  } as typeof buttonMeta;
}

function button() {
  return within(document.body).getByRole("button");
}

describe("button icon-size child swap", () => {
  it.each(["icon", "icon-sm"])(
    "renders an icon instead of the untouched label at size %s",
    async (size) => {
      const Default = composeStory(defaultStory, metaAtSize(size));

      await Default.run();

      expect(button().textContent).toBe("");
      expect(button().querySelector("svg")).not.toBeNull();
    }
  );

  it("swaps the label on Disabled too, and keeps it disabled", async () => {
    const Disabled = composeStory(disabledStory, metaAtSize("icon"));

    await Disabled.run();

    expect(button().textContent).toBe("");
    expect(button().querySelector("svg")).not.toBeNull();
    expect(button()).toBeDisabled();
  });

  // The swap used to live on Default and Disabled only, so every text-child
  // variant that renders through the meta's renderer kept the clipped label
  // when its size was changed. Outline stands in for that whole set.
  it("swaps the label on a variant that declares no render of its own", async () => {
    const Outline = composeStory(outlineStory, metaAtSize("icon"));

    await Outline.run();

    expect(button().textContent).toBe("");
    expect(button().querySelector("svg")).not.toBeNull();
  });

  it("leaves a typed-in label alone at an icon size", async () => {
    const Default = composeStory(defaultStory, metaAtSize("icon", TYPED_LABEL));

    await Default.run();

    expect(button().textContent).toBe(TYPED_LABEL);
  });

  it("keeps the default label at a non-icon size", async () => {
    const Default = composeStory(defaultStory, metaAtSize("lg"));

    await Default.run();

    expect(button().textContent).toBe(DEFAULT_LABEL);
  });
});
