/**
 * `RowRangeDragContract` only gives rows a synthetic band when the environment
 * reports a zero height, which jsdom always does. A browser keeps its own
 * geometry and takes the other arm. This stubs real per-row boxes so the story's
 * own `play` runs on the real-geometry arm, and the drag it performs has to
 * select the same three rows through the boxes the rows themselves report.
 */
import { composeStory } from "@storybook/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import gridTableV2Meta, {
  RowRangeDragContract as rowRangeDragStory,
} from "../stories/grid-table-v2.stories";
import { selectedRowIds } from "../stories/grid-table-v2-play-helpers";

const SELECTABLE_ROW_SELECTOR = "[data-grid-selectable-row]";
const REAL_ROW_HEIGHT_PX = 52;
const RANGE_ROW_COUNT = 3;
const CASE_TIMEOUT_MS = 20_000;

function boxFor(element: HTMLElement): DOMRect {
  const rows = Array.from(
    document.body.querySelectorAll<HTMLElement>(SELECTABLE_ROW_SELECTOR)
  );
  const index = rows.indexOf(element);
  if (index === -1) {
    return new DOMRect(0, 0, 0, 0);
  }
  return new DOMRect(0, index * REAL_ROW_HEIGHT_PX, 600, REAL_ROW_HEIGHT_PX);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RowRangeDragContract with rows that report real geometry", () => {
  it(
    "runs its drag assertions against the rows' own boxes instead of the synthetic band",
    async () => {
      const boxSpy = vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: HTMLElement) {
          return boxFor(this);
        });
      const Story = composeStory(rowRangeDragStory, gridTableV2Meta);

      // `run()` rejects when the story's own `play` assertions fail.
      await Story.run();

      expect(boxSpy).toHaveBeenCalled();
      expect(selectedRowIds(document.body)).toHaveLength(RANGE_ROW_COUNT);
    },
    CASE_TIMEOUT_MS
  );
});
