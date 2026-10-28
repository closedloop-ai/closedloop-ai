/**
 * Behavior test for the Table Grid Header Handles demo's resize wiring.
 *
 * The demo hands `TableGridHeader` a `getColumnWidth` reader alongside its
 * `onResize` writer, and the header only calls the reader once a resize
 * actually starts — so mounting the story, which is all the sweep does, never
 * reaches it. Driving one keyboard step proves the pair is wired end to end:
 * the demo's own track string has to move with the reported width, which is the
 * coupling `TableGridHeader` documents and cannot enforce.
 */
import { COLUMN_RESIZE_KEYBOARD_STEP_PX } from "@repo/design-system/lib/column-order";
import { composeStory } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { describe, expect, it } from "vitest";
import tableGridHeaderHandlesMeta, {
  Default as defaultStory,
} from "../stories/table-grid-header-handles.stories";

const Default = composeStory(defaultStory, tableGridHeaderHandlesMeta);

const STATUS_RESIZE_HANDLE = "Resize Status column, use arrow keys";
const RESIZE_READOUT_PATTERN = /^resized status → \d+px$/;
const INITIAL_COLUMN_WIDTH_PX = 148;
const LEAD_TRACK = "minmax(240px,1fr)";
const LAST_ACTION_PATTERN = /^(—|resized|reordered)/;
const CASE_TIMEOUT_MS = 20_000;

/** The header's rendered column tracks, read off its inline grid template. */
function gridTracks(): string[] {
  const row = document.body.querySelector<HTMLElement>(
    "[style*='grid-template-columns']"
  );
  if (!row) {
    throw new Error("the header rendered no grid template");
  }
  return row.style.gridTemplateColumns.split(" ").filter(Boolean);
}

function lastAction(): string {
  return (
    within(document.body).getAllByText(LAST_ACTION_PATTERN).at(-1)
      ?.textContent ?? ""
  );
}

describe("table grid header handles demo", () => {
  it(
    "folds a keyboard resize back into the header's own track string",
    async () => {
      await Default.run();
      // Every data column starts at the demo's one seeded width.
      expect(gridTracks()).toEqual([
        LEAD_TRACK,
        `${INITIAL_COLUMN_WIDTH_PX}px`,
        `${INITIAL_COLUMN_WIDTH_PX}px`,
        `${INITIAL_COLUMN_WIDTH_PX}px`,
        `${INITIAL_COLUMN_WIDTH_PX}px`,
      ]);

      const handle = within(document.body).getByRole("button", {
        name: STATUS_RESIZE_HANDLE,
      });
      handle.focus();
      // TWO steps, not one: each step is `getColumnWidth(id) + step`, so a
      // reader that ignored the column's CURRENT width and always answered the
      // seeded one would land on the same width both times and a single-step
      // assertion could not tell the two apart.
      await userEvent.keyboard("{ArrowRight}");
      expect(gridTracks()[1]).toBe(
        `${INITIAL_COLUMN_WIDTH_PX + COLUMN_RESIZE_KEYBOARD_STEP_PX}px`
      );

      await userEvent.keyboard("{ArrowRight}");
      expect(lastAction()).toMatch(RESIZE_READOUT_PATTERN);
      const tracks = gridTracks();
      expect(tracks[1]).toBe(
        `${INITIAL_COLUMN_WIDTH_PX + 2 * COLUMN_RESIZE_KEYBOARD_STEP_PX}px`
      );
      expect([tracks[0], ...tracks.slice(2)]).toEqual([
        LEAD_TRACK,
        `${INITIAL_COLUMN_WIDTH_PX}px`,
        `${INITIAL_COLUMN_WIDTH_PX}px`,
        `${INITIAL_COLUMN_WIDTH_PX}px`,
      ]);
    },
    CASE_TIMEOUT_MS
  );
});
