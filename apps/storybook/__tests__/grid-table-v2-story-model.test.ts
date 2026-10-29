/**
 * Unit tests for the Grid Table V2 story harness's own row model.
 *
 * The harness stories sort and group through the toolbar, which reaches only
 * the columns those menus offer. What is pinned here is the model's sort KEY
 * choice — `name` and `updated` deliberately sort by something other than the
 * string the cell renders — and the fallback it takes for a column the row has
 * no value for at all.
 */
import { describe, expect, it } from "vitest";
import {
  buildGroups,
  FIXTURE_ORDER,
  ROWS,
  sortRows,
} from "../stories/grid-table-v2-story-model";

describe("sortRows", () => {
  it("sorts the name column by the row's title", () => {
    const titles = sortRows(ROWS, "name", "asc").map((row) => row.title);

    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
    expect(titles).not.toEqual(ROWS.map((row) => row.title));
  });

  it("sorts the updated column by the sortable date rather than the row's own order", () => {
    // Oldest first: artifact-4 (Aug 23) through artifact-1 (Aug 26), the exact
    // reverse of the fixture. The fixture's labels all share one month, so this
    // sequence does NOT by itself prove the model reads `updatedAt` instead of
    // the rendered `updated` label — the case below pins that separately.
    expect(sortRows(ROWS, "updated", "asc").map((row) => row.id)).toEqual([
      "artifact-4",
      "artifact-3",
      "artifact-2",
      "artifact-1",
    ]);
  });

  it("orders a cross-year date by its sortable value, not by its label", () => {
    // "Apr 3, 2027" `localeCompare`s BEFORE every "Aug …, 2026" label, while its
    // sortable value is the LATEST of the set — so a model reading the rendered
    // label puts this row first and a model reading `updatedAt` puts it last.
    const later = {
      ...ROWS[0],
      id: "artifact-later",
      updated: "Apr 3, 2027",
      updatedAt: "2027-04-03",
    };

    expect(
      sortRows([later, ...ROWS], "updated", "asc").map((row) => row.id)
    ).toEqual([
      "artifact-4",
      "artifact-3",
      "artifact-2",
      "artifact-1",
      "artifact-later",
    ]);
  });

  it("leaves the order alone for a column no row carries a value for", () => {
    // Every row reduces to the same empty key, so a stable sort must return
    // the fixture order rather than an arbitrary permutation.
    expect(sortRows(ROWS, "not-a-column", "asc").map((row) => row.id)).toEqual(
      FIXTURE_ORDER
    );
  });

  it("returns a copy rather than sorting the shared fixture in place", () => {
    sortRows(ROWS, "name", "desc");

    expect(ROWS.map((row) => row.id)).toEqual(FIXTURE_ORDER);
  });
});

describe("buildGroups", () => {
  it("groups every row under the value it sorts by", () => {
    const groups = buildGroups(ROWS, "status");

    const grouped = groups?.flatMap((group) =>
      group.items.map((row) => row.id)
    );
    // Every row lands in exactly one band — none dropped, none duplicated.
    expect(grouped?.slice().sort()).toEqual([...FIXTURE_ORDER].sort());
    for (const group of groups ?? []) {
      expect(group.items.map((row) => row.status)).toEqual(
        group.items.map(() => group.key)
      );
    }
  });

  it("collapses every row into one empty band for a column with no values", () => {
    const groups = buildGroups(ROWS, "not-a-column");

    expect(groups).toEqual([{ key: "", label: "", items: [...ROWS] }]);
  });

  it("reports no grouping at all when no column is chosen", () => {
    expect(buildGroups(ROWS, null)).toBeUndefined();
  });
});
