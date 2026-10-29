/**
 * Behavior test for the Sidebar Section Header demo's disclosure control.
 *
 * The demo starts expanded, so the sweep only ever paints the rotated chevron.
 * Collapsing it is the other arm, and both the accessible state and the glyph
 * are asserted: dropping the class while leaving `aria-expanded` alone (or the
 * reverse) is a real regression that a single-attribute assertion would miss.
 */
import { composeStory } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { describe, expect, it } from "vitest";
import sidebarSectionHeaderMeta, {
  Interactive as interactiveStory,
} from "../stories/sidebar-section-header.stories";

const Interactive = composeStory(interactiveStory, sidebarSectionHeaderMeta);

const TOGGLE_LABEL = "Toggle teams";
const EXPANDED_CHEVRON_CLASS = "rotate-90";

function toggle(): HTMLElement {
  return within(document.body).getByRole("button", { name: TOGGLE_LABEL });
}

function chevronClassName(): string {
  const icon = toggle().querySelector("svg");
  if (!icon) {
    throw new Error("the disclosure rendered no chevron");
  }
  return icon.getAttribute("class") ?? "";
}

describe("sidebar section header demo", () => {
  it("un-rotates the chevron when the section is collapsed, and back on re-expand", async () => {
    await Interactive.run();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(chevronClassName()).toContain(EXPANDED_CHEVRON_CLASS);

    await userEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(chevronClassName()).not.toContain(EXPANDED_CHEVRON_CLASS);

    await userEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(chevronClassName()).toContain(EXPANDED_CHEVRON_CLASS);
  });
});
