/**
 * Behavior tests for the Active Filters Bar demo's filter controller.
 *
 * The story sweep already mounts these stories, so the render paths are
 * covered; what it never exercises is the controller's `clearCategoryFilter`
 * dispatch, which is only reachable by removing a chip. Each case below removes
 * exactly one category and asserts BOTH that its chip is gone and that a
 * sibling chip survived — a `default: return prev` fallthrough for the removed
 * category fails the first assertion, and a switch case that clears the wrong
 * slice fails the second.
 */
import {
  TableDateFilterField,
  TableDatePreset,
} from "@repo/design-system/components/ui/table-filters";
import { composeStories, composeStory } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { describe, expect, it } from "vitest";
import activeFiltersMeta, * as stories from "../stories/active-filters-bar.stories";

const {
  Default,
  Empty,
  HiddenAssignee,
  SurfaceChipOnly,
  SurfaceChipWithActiveFacets,
} = composeStories(stories);
const UpdatedDate = composeStory(
  {
    args: {
      initialState: {
        ...activeFiltersMeta.args.initialState,
        date: {
          field: TableDateFilterField.UpdatedAt,
          preset: TableDatePreset.Last30d,
        },
      },
    },
  },
  activeFiltersMeta
);

const HIDE_COMPLETED_CHIP = "Hide completed items";
const FAVORITES_CHIP = "My Favorites";
const ASSIGNEE_CHIP = "Assignee: 2";
const STATUS_CHIP = "Status: 2";
const PRIORITY_CHIP = "Priority: 1";
const DATE_CHIP = `Created: ${TableDatePreset.Last30d}`;
const TAGS_CHIP = "Tags: 1";
const CLEAR_ALL_PATTERN = /clear all/i;
const ADD_FILTER_LABEL = "Add filter";
const SURFACE_CHIP_LABEL = "Last 90 days";

/**
 * Every chip the `Default` story starts with, in `buildActiveChips` order.
 * Removing any one must leave the other six untouched.
 */
const DEFAULT_CHIPS = [
  HIDE_COMPLETED_CHIP,
  FAVORITES_CHIP,
  ASSIGNEE_CHIP,
  STATUS_CHIP,
  PRIORITY_CHIP,
  DATE_CHIP,
  TAGS_CHIP,
];

function menuItemStartingWith(text: string) {
  const item = within(document.body)
    .queryAllByRole("menuitem")
    .find((candidate) => candidate.textContent?.trim().startsWith(text));
  if (!item) {
    throw new Error(`no menu item starting with "${text}"`);
  }
  return item;
}

function removeLabel(chip: string) {
  return `Remove ${chip} filter`;
}

async function renderDefault() {
  await Default.run();
  return within(document.body);
}

describe("ActiveFiltersBarDemo", () => {
  it("renders one removal control per active filter category", async () => {
    const screen = await renderDefault();
    for (const chip of DEFAULT_CHIPS) {
      expect(screen.getByLabelText(removeLabel(chip))).toBeTruthy();
    }
  });

  it("labels an updated-at date filter distinctly from a created-at filter", async () => {
    await UpdatedDate.run();
    const screen = within(document.body);

    expect(
      screen.getByLabelText(removeLabel(`Updated: ${TableDatePreset.Last30d}`))
    ).toBeTruthy();
    expect(screen.queryByLabelText(removeLabel(DATE_CHIP))).toBeNull();
  });

  it.each(DEFAULT_CHIPS)(
    "removes only the %s chip when its control is clicked",
    async (chip) => {
      const screen = await renderDefault();
      await userEvent.click(screen.getByLabelText(removeLabel(chip)));

      expect(screen.queryByLabelText(removeLabel(chip))).toBeNull();
      for (const survivor of DEFAULT_CHIPS.filter((it) => it !== chip)) {
        expect(screen.getByLabelText(removeLabel(survivor))).toBeTruthy();
      }
    }
  );

  it("clears every chip at once through Clear all", async () => {
    const screen = await renderDefault();
    await userEvent.click(
      screen.getByRole("button", { name: CLEAR_ALL_PATTERN })
    );

    for (const chip of DEFAULT_CHIPS) {
      expect(screen.queryByLabelText(removeLabel(chip))).toBeNull();
    }
  });

  /**
   * Pins current behavior, which looks odd: `showFilterControls` defaults to
   * `true`, so an empty bar still renders "Clear all" with nothing to clear —
   * the very thing the prop's docstring in `active-filters-bar.tsx` says it
   * exists to prevent. Suppression happens only when a caller opts out, which
   * the `SurfaceChipOnly` case below covers. Flagged, not "fixed": a coverage
   * change never alters behavior.
   */
  it("still renders Clear all when no filter is active", async () => {
    await Empty.run();
    const screen = within(document.body);
    expect(
      screen.getByRole("button", { name: CLEAR_ALL_PATTERN })
    ).toBeTruthy();
    for (const chip of DEFAULT_CHIPS) {
      expect(screen.queryByLabelText(removeLabel(chip))).toBeNull();
    }
  });

  it("suppresses the add and clear controls when showFilterControls is false", async () => {
    await SurfaceChipOnly.run();
    const screen = within(document.body);
    expect(
      screen.queryByRole("button", { name: CLEAR_ALL_PATTERN })
    ).toBeNull();
    expect(screen.queryByLabelText(ADD_FILTER_LABEL)).toBeNull();
    expect(screen.getByText(SURFACE_CHIP_LABEL)).toBeTruthy();
  });

  it("renders the surface chip alongside facet chips and their controls", async () => {
    await SurfaceChipWithActiveFacets.run();
    const screen = within(document.body);
    expect(screen.getByText(SURFACE_CHIP_LABEL)).toBeTruthy();
    expect(screen.getByLabelText(ADD_FILTER_LABEL)).toBeTruthy();
    expect(screen.getByLabelText(removeLabel(STATUS_CHIP))).toBeTruthy();
  });

  it("hides the assignee chip when the view model hides assignees", async () => {
    await HiddenAssignee.run();
    const screen = within(document.body);
    expect(screen.queryByLabelText(removeLabel(ASSIGNEE_CHIP))).toBeNull();
    expect(screen.getByLabelText(removeLabel(STATUS_CHIP))).toBeTruthy();
  });
});

/**
 * Adding a filter goes through the same `FilterMenuContent` the popover uses,
 * but here the observable is the chip row rather than a badge count. Each case
 * toggles a value on and back off so both halves of the controller's
 * "already selected?" ternary are pinned.
 */
describe("ActiveFiltersBarDemo add-filter menu", () => {
  it.each([
    ["Assignee", "Jordan Lee", "Assignee: 1"],
    ["Status", "Draft", "Status: 1"],
    ["Priority", "High", "Priority: 1"],
    ["Tags", "Quality", "Tags: 1"],
  ])(
    "adds and removes a %s chip",
    async (category, value, chip) => {
      await Empty.run();
      const screen = within(document.body);
      expect(screen.queryByLabelText(removeLabel(chip))).toBeNull();

      await userEvent.click(screen.getByLabelText(ADD_FILTER_LABEL));
      await userEvent.click(menuItemStartingWith(category));
      await userEvent.click(menuItemStartingWith(value));
      expect(screen.getByLabelText(removeLabel(chip))).toBeTruthy();

      await userEvent.click(menuItemStartingWith(value));
      expect(screen.queryByLabelText(removeLabel(chip))).toBeNull();
    },
    20_000
  );
});
