/**
 * Behavior test for the Sidebar demo's active-path fallback.
 *
 * The demo substitutes `/sessions` for the memory adapter's starting `/` so the
 * default canvas matches the app. The story's own `play` deliberately does NOT
 * click a nav item — the preview shares one navigation adapter across every
 * story, so a click there would change the path other stories render against —
 * which leaves the substituted arm the only one the sweep ever takes. A test
 * file gets its own module registry and therefore its own adapter, so the
 * navigated arm is safe to drive here.
 */
import { composeStory } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { describe, expect, it } from "vitest";
import sidebarMeta, {
  GlobalNav as globalNavStory,
} from "../stories/sidebar.stories";

const GlobalNav = composeStory(globalNavStory, sidebarMeta);

const SESSIONS_ITEM = "Sessions";
const DASHBOARD_ITEM = "Dashboard";
const CASE_TIMEOUT_MS = 20_000;

/** The nav items currently marked active, by their link text. */
function activeItems(): string[] {
  return within(document.body)
    .getAllByRole("link")
    .filter((link) => link.getAttribute("data-active") === "true")
    .map((link) => link.textContent?.trim() ?? "");
}

describe("sidebar GlobalNav demo", () => {
  it(
    "marks Sessions active before navigation and follows the path afterwards",
    async () => {
      await GlobalNav.run();
      // The adapter starts at "/", which no nav item points at; the demo shows
      // Sessions instead so the default canvas is not blank.
      expect(activeItems()).toEqual([SESSIONS_ITEM]);

      await userEvent.click(
        within(document.body).getByRole("link", { name: DASHBOARD_ITEM })
      );

      // Once a real path exists the substitution stops, so the active mark
      // moves off Sessions entirely rather than sticking alongside.
      expect(activeItems()).toEqual([DASHBOARD_ITEM]);
    },
    CASE_TIMEOUT_MS
  );
});
