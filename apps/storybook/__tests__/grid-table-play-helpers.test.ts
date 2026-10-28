/**
 * Unit tests for the DOM helpers `grid-table.stories.tsx`'s `play` functions
 * read the header and body through.
 *
 * `headerColumnIds` identifies the header by ELIMINATION — the one `role="row"`
 * that is not a body row — so a render that paints no header at all would
 * otherwise return the ids of whatever row happened to come first. The guard
 * that stops it is what a passing play never reaches, so it is pinned here.
 */
import { describe, expect, it } from "vitest";
import {
  bodyRows,
  columnIdsWithin,
  headerColumnIds,
} from "../stories/grid-table-play-helpers";

/** A detached canvas built from markup, so no story has to mount. */
function canvas(html: string): HTMLElement {
  const element = document.createElement("div");
  element.innerHTML = html;
  return element;
}

const HEADER_AND_BODY = `
  <div role="row">
    <div data-column-id="owner">Owner</div>
    <div data-column-id="status">Status</div>
  </div>
  <div data-grid-row="" role="row">
    <div data-column-id="owner">Pascoe Birchall</div>
    <div data-column-id="status">active</div>
  </div>
`;

describe("headerColumnIds", () => {
  it("reads the header row rather than the first body row", () => {
    expect(headerColumnIds(canvas(HEADER_AND_BODY))).toEqual([
      "owner",
      "status",
    ]);
  });

  it("raises rather than reporting a body row's ids when no header painted", () => {
    const bodyOnly = canvas(`
      <div data-grid-row="" role="row">
        <div data-column-id="owner">Pascoe Birchall</div>
      </div>
    `);

    expect(() => headerColumnIds(bodyOnly)).toThrow(
      "grid table rendered no header row"
    );
  });
});

describe("bodyRows", () => {
  it("returns only the rows marked as body rows", () => {
    const rows = bodyRows(canvas(HEADER_AND_BODY));

    expect(rows).toHaveLength(1);
    expect(columnIdsWithin(rows[0] as Element)).toEqual(["owner", "status"]);
  });
});
