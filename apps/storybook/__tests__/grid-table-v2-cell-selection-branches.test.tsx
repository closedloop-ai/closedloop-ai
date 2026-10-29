import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import gridTableV2CellMeta, {
  Default as defaultStory,
} from "../stories/grid-table-v2-cell.stories";
import { rowCell, selectedRowIds } from "../stories/grid-table-v2-play-helpers";
import { renderStoryWithoutPlay } from "./helpers/compose-story-without-play";

const FIRST_ROW = "row-1";
const SECOND_ROW = "row-2";
const OWNER_COLUMN = "owner";
const CASE_TIMEOUT_MS = 20_000;

describe("Grid Table V2 Cell harness selection toggle", () => {
  it(
    "deselects only the toggled row when Space is pressed on an already selected row",
    async () => {
      await renderStoryWithoutPlay(defaultStory, gridTableV2CellMeta);
      const body = document.body;

      fireEvent.keyDown(rowCell(body, FIRST_ROW, OWNER_COLUMN), { key: " " });
      fireEvent.keyDown(rowCell(body, SECOND_ROW, OWNER_COLUMN), { key: " " });
      expect(selectedRowIds(body)).toEqual([FIRST_ROW, SECOND_ROW]);

      fireEvent.keyDown(rowCell(body, FIRST_ROW, OWNER_COLUMN), { key: " " });
      expect(selectedRowIds(body)).toEqual([SECOND_ROW]);
    },
    CASE_TIMEOUT_MS
  );
});
