/**
 * Behavior tests for the Grid Table demos' own state, which the story sweep
 * mounts but never drives.
 *
 * Three demos own a reducer the sweep leaves at its initial value: `Sortable`'s
 * comparator (direction and the null-value fallback), `ReorderableAndHideable`'s
 * hidden-column set, and `LeadingUtilityColumn`'s selection set. Each of those
 * is a two-armed branch, so every case below drives it BOTH ways — a test that
 * only hides a column, or only checks a row, leaves the removal half unpinned
 * and a toggle that never un-toggles still passes it.
 */
import { composeStory } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { describe, expect, it } from "vitest";
import gridTableMeta, {
  LeadingUtilityColumn as leadingUtilityStory,
  ReorderableAndHideable as reorderableStory,
  Sortable as sortableStory,
} from "../stories/grid-table.stories";
import { bodyRows, headerColumnIds } from "../stories/grid-table-play-helpers";

const Sortable = composeStory(sortableStory, gridTableMeta);
const ReorderableAndHideable = composeStory(reorderableStory, gridTableMeta);
const LeadingUtilityColumn = composeStory(leadingUtilityStory, gridTableMeta);

const VIEW_TRIGGER = "View";
const SELECT_ALL_LABEL = "Select all rows";
const MODEL_SWITCH_ID = "col-model";
const CHECKED = "true";
const UNCHECKED = "false";
const CASE_TIMEOUT_MS = 20_000;

/** Row name → the owner and model the fixture gives it, for readable ordering. */
const ROW_NAMES = {
  refactor: "agent/refactor-auth-guard",
  seed: "agent/seed-generator",
  tokenRounding: "fix/token-rounding",
} as const;

/** The lead-cell name of every painted body row, in painted order. */
function renderedRowNames(): string[] {
  return bodyRows(document.body).map((row) => {
    const name = Object.values(ROW_NAMES).find((candidate) =>
      row.textContent?.includes(candidate)
    );
    if (name === undefined) {
      throw new Error(`row matched no fixture name: ${row.textContent}`);
    }
    return name;
  });
}

function columnHeader(label: string) {
  return within(document.body).getByRole("button", { name: label });
}

/** Every column switch in the view menu as `switch id → checked`. */
function columnSwitchStates(): Record<string, string | null> {
  return Object.fromEntries(
    within(document.body)
      .queryAllByRole("switch")
      .map((toggle) => [toggle.id, toggle.getAttribute("aria-checked")])
  );
}

describe("grid table Sortable demo", () => {
  it("starts sorted by owner, ascending", async () => {
    await Sortable.run();

    // Alex Rivera, Pascoe Birchall, Sam Chen.
    expect(renderedRowNames()).toEqual([
      ROW_NAMES.seed,
      ROW_NAMES.refactor,
      ROW_NAMES.tokenRounding,
    ]);
  });

  it(
    "sorts a fresh column descending first, then ascending on the second press",
    async () => {
      await Sortable.run();

      // Model is the column with a null value, so both presses also exercise
      // the comparator's empty-string fallback for the row that has none.
      await userEvent.click(columnHeader("Model"));
      expect(renderedRowNames()).toEqual([
        ROW_NAMES.seed,
        ROW_NAMES.refactor,
        ROW_NAMES.tokenRounding,
      ]);

      await userEvent.click(columnHeader("Model"));
      // The null model sorts as "" and therefore leads the ascending pass —
      // pins current behavior; an unavailable model reads as the lowest value
      // rather than being held out of the ordering.
      expect(renderedRowNames()).toEqual([
        ROW_NAMES.tokenRounding,
        ROW_NAMES.refactor,
        ROW_NAMES.seed,
      ]);
    },
    CASE_TIMEOUT_MS
  );
});

describe("grid table ReorderableAndHideable demo", () => {
  it(
    "drops a hidden column's track and restores it on the second toggle",
    async () => {
      await ReorderableAndHideable.run();
      const initialColumnIds = headerColumnIds(document.body);
      expect(initialColumnIds).toContain("model");

      await userEvent.click(columnHeader(VIEW_TRIGGER));
      const before = columnSwitchStates();
      await userEvent.click(
        within(document.body).getByRole("switch", { name: "Model" })
      );

      // Every switch is read, not just the clicked one: a toggle that flipped
      // all columns still flips the target and would pass a single assertion.
      expect(columnSwitchStates()).toEqual({
        ...before,
        [MODEL_SWITCH_ID]: UNCHECKED,
      });
      expect(headerColumnIds(document.body)).toEqual(
        initialColumnIds.filter((id) => id !== "model")
      );

      await userEvent.click(
        within(document.body).getByRole("switch", { name: "Model" })
      );
      expect(columnSwitchStates()).toEqual(before);
      expect(headerColumnIds(document.body)).toEqual(initialColumnIds);
    },
    CASE_TIMEOUT_MS
  );
});

describe("grid table LeadingUtilityColumn demo", () => {
  /** Every row checkbox as `accessible name → checked`. */
  function rowCheckboxStates(): Record<string, string | null> {
    return Object.fromEntries(
      within(document.body)
        .queryAllByRole("checkbox")
        .map((box) => [
          box.getAttribute("aria-label"),
          box.getAttribute("aria-checked"),
        ])
    );
  }

  it(
    "adds an unchecked row to the selection and removes a checked one",
    async () => {
      await LeadingUtilityColumn.run();
      const initial = rowCheckboxStates();
      // The fixture seeds one row as already selected, so a single case can
      // drive both arms of the toggle.
      expect(initial[`Select ${ROW_NAMES.seed}`]).toBe(CHECKED);
      expect(initial[`Select ${ROW_NAMES.refactor}`]).toBe(UNCHECKED);

      await userEvent.click(
        within(document.body).getByRole("checkbox", {
          name: `Select ${ROW_NAMES.refactor}`,
        })
      );
      expect(rowCheckboxStates()).toEqual({
        ...initial,
        [`Select ${ROW_NAMES.refactor}`]: CHECKED,
      });

      await userEvent.click(
        within(document.body).getByRole("checkbox", {
          name: `Select ${ROW_NAMES.seed}`,
        })
      );
      expect(rowCheckboxStates()).toEqual({
        ...initial,
        [`Select ${ROW_NAMES.refactor}`]: CHECKED,
        [`Select ${ROW_NAMES.seed}`]: UNCHECKED,
      });
    },
    CASE_TIMEOUT_MS
  );

  it(
    "select-all checks every row, and clearing it empties the selection",
    async () => {
      await LeadingUtilityColumn.run();

      await userEvent.click(
        within(document.body).getByRole("checkbox", {
          name: SELECT_ALL_LABEL,
        })
      );
      expect(rowCheckboxStates()).toEqual({
        [SELECT_ALL_LABEL]: CHECKED,
        [`Select ${ROW_NAMES.refactor}`]: CHECKED,
        [`Select ${ROW_NAMES.seed}`]: CHECKED,
        [`Select ${ROW_NAMES.tokenRounding}`]: CHECKED,
      });

      await userEvent.click(
        within(document.body).getByRole("checkbox", {
          name: SELECT_ALL_LABEL,
        })
      );
      expect(rowCheckboxStates()).toEqual({
        [SELECT_ALL_LABEL]: UNCHECKED,
        [`Select ${ROW_NAMES.refactor}`]: UNCHECKED,
        // Clearing drops the row the fixture had pre-selected too, rather than
        // returning the selection to its seeded state.
        [`Select ${ROW_NAMES.seed}`]: UNCHECKED,
        [`Select ${ROW_NAMES.tokenRounding}`]: UNCHECKED,
      });
    },
    CASE_TIMEOUT_MS
  );
});
