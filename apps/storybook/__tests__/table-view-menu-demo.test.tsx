/**
 * Behavior tests for the Table View Menu demo's column toggles.
 *
 * Each case asserts the state of EVERY switch before and after the click, not
 * just the one clicked. That is what pins the non-matching half of the
 * `column.id === columnId ? … : column` map — a toggle that flipped all
 * columns, or the wrong one, still flips the target and would pass a
 * single-switch assertion.
 */
import { composeStory } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { describe, expect, it } from "vitest";
import tableViewMenuMeta, {
  ColumnsOnly as columnsOnlyStory,
  Default as defaultStory,
} from "../stories/table-view-menu.stories";

const Default = composeStory(defaultStory, tableViewMenuMeta);
const ColumnsOnly = composeStory(columnsOnlyStory, tableViewMenuMeta);

const VIEW_TRIGGER = "View";
const HIDDEN_COLUMN_ID = "col-project";
const VISIBLE_COLUMN_ID = "col-type";
const CASE_TIMEOUT_MS = 20_000;

/** Every column switch as `id → checked`, so one click can be isolated. */
function switchStates() {
  return Object.fromEntries(
    within(document.body)
      .queryAllByRole("switch")
      .map((toggle) => [toggle.id, toggle.getAttribute("aria-checked")])
  );
}

function switchById(id: string) {
  const toggle = within(document.body)
    .queryAllByRole("switch")
    .find((candidate) => candidate.id === id);
  if (!toggle) {
    throw new Error(`no column switch with id "${id}"`);
  }
  return toggle;
}

async function openMenu() {
  await userEvent.click(
    within(document.body).getByRole("button", { name: VIEW_TRIGGER })
  );
}

describe("TableViewMenuDemo", () => {
  it(
    "shows a hidden column and leaves every other column alone",
    async () => {
      await Default.run();
      await openMenu();
      const before = switchStates();
      expect(before[HIDDEN_COLUMN_ID]).toBe("false");

      await userEvent.click(switchById(HIDDEN_COLUMN_ID));

      expect(switchStates()).toEqual({
        ...before,
        [HIDDEN_COLUMN_ID]: "true",
      });
    },
    CASE_TIMEOUT_MS
  );

  it(
    "hides a visible column and leaves every other column alone",
    async () => {
      await Default.run();
      await openMenu();
      const before = switchStates();
      expect(before[VISIBLE_COLUMN_ID]).toBe("true");

      await userEvent.click(switchById(VISIBLE_COLUMN_ID));

      expect(switchStates()).toEqual({
        ...before,
        [VISIBLE_COLUMN_ID]: "false",
      });
    },
    CASE_TIMEOUT_MS
  );

  it(
    "toggles a column back to where it started",
    async () => {
      await Default.run();
      await openMenu();
      const before = switchStates();

      await userEvent.click(switchById(HIDDEN_COLUMN_ID));
      await userEvent.click(switchById(HIDDEN_COLUMN_ID));

      expect(switchStates()).toEqual(before);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "toggles a column in the columns-only variant",
    async () => {
      await ColumnsOnly.run();
      await openMenu();
      const before = switchStates();
      expect(before[HIDDEN_COLUMN_ID]).toBe("false");

      await userEvent.click(switchById(HIDDEN_COLUMN_ID));

      expect(switchStates()).toEqual({
        ...before,
        [HIDDEN_COLUMN_ID]: "true",
      });
    },
    CASE_TIMEOUT_MS
  );
});
