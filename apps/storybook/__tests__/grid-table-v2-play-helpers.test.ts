/**
 * Unit tests for the DOM helpers `grid-table-v2.stories.tsx`'s `play` functions
 * address the grid through.
 *
 * The stories exercise their happy paths, so what is pinned here is the half a
 * green play never reaches: what each helper does when the element it is asked
 * for is absent. Those guards are the difference between a play failing at the
 * step that broke and a play failing several steps later on a null it silently
 * carried forward, so each one owes an assertion on the message it raises.
 */
import { HEADER_ROW_ID } from "@repo/design-system/lib/grid-table-v2-chrome-rows";
import { describe, expect, it } from "vitest";
import {
  gridTemplateTracks,
  renderedGroups,
  renderedRowIds,
  rowCell,
  selectedRowIds,
} from "../stories/grid-table-v2-play-helpers";

/** A detached canvas built from markup, so no story has to mount. */
function canvas(html: string): HTMLElement {
  const element = document.createElement("div");
  element.innerHTML = html;
  return element;
}

const TWO_ROW_GRID = `
  <div data-grid-row-id="row-1" style="grid-template-columns: 280px 180px;">
    <div data-column-id="title">First</div>
    <div data-column-id="status">Open</div>
  </div>
  <div aria-selected="true" data-grid-row-id="row-2">
    <div data-column-id="title">Second</div>
  </div>
`;

describe("renderedRowIds", () => {
  it("reads the data rows in painted order", () => {
    expect(renderedRowIds(canvas(TWO_ROW_GRID))).toEqual(["row-1", "row-2"]);
  });

  it("drops the chrome rows the grid paints alongside the data rows", () => {
    const element = canvas(
      `<div data-grid-row-id="${HEADER_ROW_ID}"></div>${TWO_ROW_GRID}`
    );

    expect(renderedRowIds(element)).toEqual(["row-1", "row-2"]);
  });
});

describe("selectedRowIds", () => {
  it("reports only the rows carrying aria-selected", () => {
    expect(selectedRowIds(canvas(TWO_ROW_GRID))).toEqual(["row-2"]);
  });
});

describe("renderedGroups", () => {
  it("pairs each section's header label with the rows beneath it", () => {
    const element = canvas(`
      <div role="rowgroup">
        <div aria-expanded="true"><span>Open</span></div>
        <div data-grid-row-id="row-1"></div>
        <div data-grid-row-id="row-2"></div>
      </div>
    `);

    expect(renderedGroups(element)).toEqual([
      { label: "Open", rowIds: ["row-1", "row-2"] },
    ]);
  });

  it("reports an empty label for a section that painted no header", () => {
    // A section rendered without its disclosure still has to report its rows:
    // the alternative is a `null` label the caller compares against and never
    // matches, which reads as "the grouping is wrong" rather than "the header
    // is missing".
    const element = canvas(`
      <div role="rowgroup">
        <div data-grid-row-id="row-1"></div>
      </div>
    `);

    expect(renderedGroups(element)).toEqual([{ label: "", rowIds: ["row-1"] }]);
  });
});

describe("gridTemplateTracks", () => {
  it("splits the track string off the first painted row's inline style", () => {
    expect(gridTemplateTracks(canvas(TWO_ROW_GRID))).toEqual([
      "280px",
      "180px",
    ]);
  });

  it("pins the chrome row winning the track read once the header is navigable", () => {
    // Pins current behavior, and it looks wrong. `renderedRowIds` filters
    // chrome ids through `isGridChromeRowId` precisely because ISS-8930 gave
    // the column-header row a `data-grid-row-id` too; this helper reads the
    // same attribute and does NOT filter, so with `navigableHeaderCells` open
    // it measures the HEADER's tracks and calls them the body's. The guard
    // message ("grid rendered no body rows") makes the same claim.
    // Filtering here would change behavior, which this coverage ticket
    // forbids — so the tripwire is armed and the fix belongs to its own PR.
    const element = canvas(
      `<div data-grid-row-id="${HEADER_ROW_ID}" style="grid-template-columns: 999px 111px;"></div>${TWO_ROW_GRID}`
    );

    expect(gridTemplateTracks(element)).toEqual(["999px", "111px"]);
  });

  it("raises rather than returning an empty track list when no row painted", () => {
    expect(() => gridTemplateTracks(canvas(""))).toThrow(
      "grid rendered no body rows"
    );
  });
});

describe("rowCell", () => {
  it("addresses a cell by row id and column id, not by position", () => {
    expect(rowCell(canvas(TWO_ROW_GRID), "row-2", "title").textContent).toBe(
      "Second"
    );
  });

  it("names the missing ROW when the grid painted no such row", () => {
    expect(() => rowCell(canvas(TWO_ROW_GRID), "row-9", "title")).toThrow(
      "no rendered row for row-9"
    );
  });

  it("names the missing COLUMN when the row painted no such cell", () => {
    expect(() => rowCell(canvas(TWO_ROW_GRID), "row-2", "status")).toThrow(
      "no status cell in row-2"
    );
  });
});
