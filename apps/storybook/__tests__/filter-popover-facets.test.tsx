/**
 * Behavior test for the Filter Popover's facet-group toggle.
 *
 * The `FacetGroups` story owns its own selection reducer, and that reducer is a
 * single ternary: already-selected values are filtered out, new ones appended.
 * The `StatusFacetSubmenu` story's `play` only ever adds, so the removal arm is
 * never taken — this drives both, and asserts the whole facet's selection each
 * time rather than only the row that was clicked.
 */
import { composeStory } from "@storybook/react";
import { screen, userEvent, within } from "storybook/test";
import { describe, expect, it } from "vitest";
import filterPopoverMeta, {
  FacetGroups as facetGroupsStory,
} from "../stories/filter-popover.stories";

const FacetGroups = composeStory(facetGroupsStory, filterPopoverMeta);

const FILTER_TRIGGER_PATTERN = /^Filter/;
const STATUS_SUBMENU = "Status";
const OPEN_ROW = "Open";
const IN_REVIEW_ROW = "In review";
const MERGED_ROW = "Merged";
const CASE_TIMEOUT_MS = 20_000;

/**
 * Every status row as `label → checked`, read off the checkbox each row paints.
 * That is the state assistive tech reports, so a selection the reducer tracked
 * but never rendered cannot satisfy this.
 */
function statusSelection(): Record<string, string | null> {
  return Object.fromEntries(
    [OPEN_ROW, IN_REVIEW_ROW, MERGED_ROW].map((label) => {
      const row = within(document.body)
        .queryAllByRole("menuitem")
        .find((candidate) => candidate.textContent?.startsWith(label));
      if (!row) {
        throw new Error(`no status row for "${label}"`);
      }
      const box = row.querySelector('[role="checkbox"]');
      if (!box) {
        throw new Error(`status row "${label}" painted no checkbox`);
      }
      return [label, box.getAttribute("aria-checked")];
    })
  );
}

async function clickStatusRow(label: string) {
  await userEvent.click(await screen.findByText(label));
}

describe("filter popover facet groups", () => {
  it(
    "appends an unselected facet value and removes an already-selected one",
    async () => {
      await FacetGroups.run();
      await userEvent.click(
        within(document.body).getAllByRole("button", {
          name: FILTER_TRIGGER_PATTERN,
        })[0] as HTMLElement
      );
      await userEvent.click(await screen.findByText(STATUS_SUBMENU));

      // The story seeds "Open", so one case can drive both arms.
      expect(statusSelection()).toEqual({
        [OPEN_ROW]: "true",
        [IN_REVIEW_ROW]: "false",
        [MERGED_ROW]: "false",
      });

      await clickStatusRow(IN_REVIEW_ROW);
      expect(statusSelection()).toEqual({
        [OPEN_ROW]: "true",
        [IN_REVIEW_ROW]: "true",
        [MERGED_ROW]: "false",
      });

      await clickStatusRow(OPEN_ROW);
      // Removing the seeded value leaves the one just added, rather than
      // replacing the whole selection with the clicked row.
      expect(statusSelection()).toEqual({
        [OPEN_ROW]: "false",
        [IN_REVIEW_ROW]: "true",
        [MERGED_ROW]: "false",
      });
    },
    CASE_TIMEOUT_MS
  );
});
