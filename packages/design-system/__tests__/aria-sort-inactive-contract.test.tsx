import {
  AriaSort,
  getAriaSort,
} from "@closedloop-ai/design-system/components/ui/sortable-column-header";
import {
  TableGridHeaderV2,
  type TableGridHeaderV2Column,
} from "@closedloop-ai/design-system/components/ui/table-grid-header-v2";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * ISS-10425. `getAriaSort` publishes a THREE-way contract, and the middle value
 * is the one that keeps being read as a bug:
 *
 *   attribute ABSENT   the column is not a sort control at all
 *   `none`             sortable, not currently sorted
 *   ascending/descending   the one column that owns the sort
 *
 * `none` is `aria-sort`'s defined default, so `none` and absent are the same
 * value to a screen reader — which is exactly why deleting the explicit `none`
 * would buy no user anything while collapsing the first two rows into one. That
 * argument lives in `getAriaSort`'s docstring; this file is what stops the
 * collapse from landing silently.
 *
 * WHAT THIS FILE OWNS, and nothing wider. Two things, both unowned before it:
 *
 *   1. `getAriaSort` itself, called directly against bare literals. No other
 *      suite or story calls it with an expectation that could fail when it
 *      changes — `sortable-column-header.stories.tsx`'s `Default` play passes
 *      `getAriaSort(true, "desc")` AS its expected value, which restates the
 *      function under test and stays green through any edit to it.
 *   2. A NOT-SORTABLE v2 column carrying no `aria-sort` at all. Every column in
 *      `table-grid-header-v2.stories.tsx`'s fixture is `sortable: true`, so the
 *      absent arm had no owner on v2.
 *
 * Everything else the three consumers assert already has exactly one owner, and
 * this file deliberately does NOT restate it (packages/design-system/AGENTS.md
 * → "Put a new assertion where its subject already lives rather than starting a
 * fourth copy"):
 *
 *   - v1, all three arms, on the production `GridTable` path:
 *     `packages/app/shared/lib/__tests__/grid-table-aria-semantics.test.tsx`
 *     ("announces sort state only on the columns that can be sorted").
 *   - v1 sorted + inactive-`none`: `table-grid-header.stories.tsx`'s `Default`
 *     play. v2 sorted + inactive-`none`: `table-grid-header-v2.stories.tsx`'s
 *     `Sorting` play.
 *   - `SortableColumnHeader`, every arm: `sortable-column-header.stories.tsx`'s
 *     `Unsorted` and `SortCycle` plays, which pin `AriaSort.None`,
 *     `.Descending` and `.Ascending` as constants through real clicks.
 *
 * The rendered case below mounts inside a `role="grid"` and locates its header
 * THROUGH that grid. `columnheader`'s required context role is `row`, and
 * `row`'s is `table`/`grid`/`treegrid`/`rowgroup`, so a `columnheader` with no
 * such ancestor is an invalid accessibility tree (axe `aria-required-parent`;
 * the prop's own docstring says the same at `table-grid-header-v2.tsx:187-190`).
 * jsdom does not enforce required context, so an unwrapped mount would pin this
 * contract in a shape no browser produces — green, and wrong. Locating through
 * `getByRole("grid")` is what makes the wrapper load-bearing instead of
 * decorative: delete it and the query throws before any `aria-sort` is read.
 *
 * The absence assertion is PAIRED on purpose: a `not.toHaveAttribute` alone is
 * satisfied by a locator that matched nothing, so it sits beside a positive
 * assertion on the SAME element plus a sortable sibling from the same header
 * row that proves this render does emit `aria-sort` where it should. Expected
 * values are bare literals or the `AriaSort` contract constant, never a
 * `getAriaSort(...)` call — restating the function under test would keep the
 * case green through any change to it.
 */

const SORTED_COLUMN_ID = "updated";
const INACTIVE_COLUMN_ID = "status";
const STATIC_COLUMN_ID = "ratio";

const SORTED_NAME = /Updated/;
const INACTIVE_NAME = /Status/;
const STATIC_NAME = /Ratio/;

const GRID_COLUMNS = [
  { id: INACTIVE_COLUMN_ID, label: "Status", sortable: true },
  { id: SORTED_COLUMN_ID, label: "Updated", sortable: true },
  // No `sortable`, so this header must carry no `aria-sort` whatsoever.
  { id: STATIC_COLUMN_ID, label: "Ratio" },
] as const satisfies readonly TableGridHeaderV2Column[];

const GRID_TEMPLATE_COLUMNS = "200px repeat(3, 160px)";

describe("getAriaSort", () => {
  it("announces a direction only for the active column", () => {
    expect(getAriaSort(true, "asc")).toBe("ascending");
    expect(getAriaSort(true, "desc")).toBe("descending");
  });

  it("returns the explicit none for an inactive column, in either direction", () => {
    // Both arms, because an inactive column must not leak the direction the
    // ACTIVE column happens to be sorted in.
    expect(getAriaSort(false, "asc")).toBe("none");
    expect(getAriaSort(false, "desc")).toBe("none");
  });

  it("never returns undefined, which is what absent would mean", () => {
    // The mutation this file exists to catch spells itself `undefined`.
    expect(getAriaSort(false, "desc")).toBeDefined();
    expect(AriaSort.None).toBe("none");
  });
});

describe("TableGridHeaderV2 rendered sort state", () => {
  it("withholds aria-sort entirely from a column that is not sortable", () => {
    render(
      // `insideAriaTable` promotes the row to `role="row"` and its cells to
      // `role="columnheader"`, both of which require a `grid` ancestor here —
      // `GridTableV2` supplies it in production (`table-grid-header-v2.tsx:181`).
      // The wrapper must be the container the header actually ships inside:
      // `GridTableV2` is a CSS grid of divs carrying `role="grid"`
      // (`grid-table-v2.tsx:1014`), not a `<table>`. Swapping in the semantic
      // element would test a context production never renders, and would nest a
      // `div` row inside a `<table>` content model on top of that.
      // biome-ignore lint/a11y/useSemanticElements: see above — a `<table>` here would not be the context under test.
      <div role="grid">
        <TableGridHeaderV2
          columns={GRID_COLUMNS}
          gridTemplateColumns={GRID_TEMPLATE_COLUMNS}
          insideAriaTable={true}
          onSort={vi.fn()}
          sortBy={SORTED_COLUMN_ID}
          sortDir="desc"
        />
      </div>
    );

    const grid = within(screen.getByRole("grid"));
    const staticHeader = grid.getByRole("columnheader", { name: STATIC_NAME });

    // Presence first, on the same element the absence is asserted on: without
    // it, a locator that resolved nothing would satisfy the negative below.
    expect(staticHeader).toHaveAttribute("aria-colindex");
    expect(staticHeader).not.toHaveAttribute("aria-sort");

    // The sortable siblings in the SAME row, so "no `aria-sort` on Ratio" reads
    // as a deliberate omission rather than as a render that emitted none at all.
    expect(
      grid.getByRole("columnheader", { name: SORTED_NAME })
    ).toHaveAttribute("aria-sort", "descending");
    expect(
      grid.getByRole("columnheader", { name: INACTIVE_NAME })
    ).toHaveAttribute("aria-sort", AriaSort.None);
  });
});
