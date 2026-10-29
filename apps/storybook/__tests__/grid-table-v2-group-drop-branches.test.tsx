import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import gridTableV2Meta, {
  RowRangeDragWithGroupDropContract as groupDropStory,
} from "../stories/grid-table-v2.stories";
import { renderedGroups } from "../stories/grid-table-v2-play-helpers";
import { renderStoryWithoutPlay } from "./helpers/compose-story-without-play";

const GROUP_ROW_DRAG_TYPE = "text/grid-row-id";
const DRAGGED_ROW_ID = "artifact-1";
const ACTIVE_BAND_LABEL = "Active";
const CASE_TIMEOUT_MS = 20_000;

/** A `DataTransfer` double that keeps what `dragstart` wrote for `drop` to read. */
function createDataTransfer() {
  const entries = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "none",
    setData: (type: string, value: string) => {
      entries.set(type, value);
    },
    getData: (type: string) => entries.get(type) ?? "",
  };
}

function rowElement(rowId: string): HTMLElement {
  const row = document.body.querySelector<HTMLElement>(
    `[data-grid-row-id="${rowId}"]`
  );
  if (!row) {
    throw new Error(`no row rendered for ${rowId}`);
  }
  return row;
}

function bandElement(label: string): HTMLElement {
  const band = Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="rowgroup"]')
  ).find(
    (section) =>
      section.querySelector("[aria-expanded] span")?.textContent === label
  );
  if (!band) {
    throw new Error(`no band rendered for ${label}`);
  }
  return band;
}

describe("Grid Table V2 harness group drop", () => {
  it(
    "moves the dragged row into the band it is dropped on and leaves other rows alone",
    async () => {
      await renderStoryWithoutPlay(groupDropStory, gridTableV2Meta);
      expect(renderedGroups(document.body)).toEqual([
        { label: "In review", rowIds: [DRAGGED_ROW_ID] },
        { label: ACTIVE_BAND_LABEL, rowIds: ["artifact-2", "artifact-4"] },
        { label: "Draft", rowIds: ["artifact-3"] },
      ]);

      const dataTransfer = createDataTransfer();
      fireEvent.dragStart(rowElement(DRAGGED_ROW_ID), { dataTransfer });
      expect(dataTransfer.getData(GROUP_ROW_DRAG_TYPE)).toBe(DRAGGED_ROW_ID);
      fireEvent.drop(bandElement(ACTIVE_BAND_LABEL), { dataTransfer });

      expect(renderedGroups(document.body)).toEqual([
        {
          label: ACTIVE_BAND_LABEL,
          rowIds: [DRAGGED_ROW_ID, "artifact-2", "artifact-4"],
        },
        { label: "Draft", rowIds: ["artifact-3"] },
      ]);
    },
    CASE_TIMEOUT_MS
  );
});
