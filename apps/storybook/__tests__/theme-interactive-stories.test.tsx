/**
 * ISS-10237 — the `themeInteractive` opt-out, executed rather than assumed.
 *
 * `.storybook/preview.tsx` pins every story's `ThemeProvider` to the toolbar
 * theme, which makes `setTheme` a no-op. Mode Toggle and Theme Submenu, whose
 * whole subject is switching the theme, opt out with
 * `parameters: { themeInteractive: true }`. Nothing executed that opt-out: the
 * sweep only runs a `play` when one exists, so deleting or misspelling the
 * parameter turned both controls into no-ops with the suite still green.
 *
 * Each case drives the real control and asserts the class next-themes writes on
 * `<html>` actually changed — the observable that the pin suppresses.
 */
import { composeStory } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import modeToggleMeta, {
  Default as modeToggleStory,
} from "../stories/mode-toggle.stories";
import themeSubmenuMeta, {
  Default as themeSubmenuStory,
} from "../stories/theme-submenu.stories";

const THEME_STORAGE_KEY = "theme";

function resetTheme() {
  localStorage.removeItem(THEME_STORAGE_KEY);
  document.documentElement.classList.remove("light", "dark");
}

beforeEach(resetTheme);
afterEach(resetTheme);

describe("theme-interactive stories", () => {
  it("lets Mode Toggle apply a theme the preview pin would have swallowed", async () => {
    const ModeToggle = composeStory(modeToggleStory, modeToggleMeta);

    await ModeToggle.run();
    const body = within(document.body);
    await userEvent.click(body.getByRole("button", { name: "Toggle theme" }));
    await userEvent.click(await body.findByText("Dark"));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("lets Theme Submenu apply a theme the preview pin would have swallowed", async () => {
    const ThemeSubmenu = composeStory(themeSubmenuStory, themeSubmenuMeta);

    await ThemeSubmenu.run();
    const body = within(document.body);
    await userEvent.click(body.getByText("Open"));
    await userEvent.click(await body.findByText("Theme"));
    await userEvent.click(
      await body.findByRole("menuitemradio", { name: "Dark" })
    );

    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
