import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { pinSessionFixtureClock } from "@repo/app/test/mocks/session-fixture-clock";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS,
  SESSIONS_SEAM_REQUIRED_COLUMN_IDS,
} from "../../../lib/sessions-column-visibility";
import { SESSIONS_DATA_COLUMN_ORDER } from "../../../lib/sessions-table-columns";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/**
 * `SessionsListSurfaceV2` must not render a column whose cell content it cannot
 * produce.
 *
 * `SESSIONS_SEAM_REQUIRED_COLUMN_IDS` (`projects`, `issues`) names the columns
 * whose values a presentational table cannot derive from a `SessionTableRow` —
 * both fields are cloud-only projections, so the HOST wires a render seam or the
 * column is dropped along with its grid track. `SessionsTable` honors that via
 * its optional `renderProjects`/`renderIssues` props. This surface renders its
 * own cells through `sessionCellValue`, which has no entry for either id, so it
 * previously rendered both columns as a full track of em dashes — the precise
 * outcome that constant's docstring exists to prevent.
 *
 * Asserted on the RENDERED grid, not on the module's column list: a regression
 * that reintroduces the ids, and one that adds a `sessionCellValue` entry
 * returning nothing, both surface here as a visible column.
 */

const ROWS: SessionTableRow[] = [
  createSessionTableRowFixture({
    autonomy: 88,
    branch: "fix/seam-required-columns",
    id: "session-1",
    repo: "closedloop-ai/closedloop-ai",
    status: "Active",
    user: { avatarUrl: null, name: "Pascoe Birchall" },
  }),
  createSessionTableRowFixture({
    autonomy: 41,
    branch: "chore/second-row",
    id: "session-2",
    repo: "closedloop-ai/closedloop-ai",
    status: "Completed",
    user: { avatarUrl: null, name: "Marisol Ashgrove" },
  }),
];

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

pinSessionFixtureClock();

describe("SessionsListSurfaceV2 seam-required columns", () => {
  /**
   * Deliberately ONE mount for all three assertions rather than one per `it`.
   * This surface renders the toolbar, its four menus and the summary strip, so a
   * mount is expensive; three of them measurably slowed the whole
   * `agents/components/sessions` run and tipped two already-marginal neighbours
   * (`synced-sessions-table-states`, `sessions-toolbar` — both ~21s, both on the
   * default 5s per-test timeout) into timing out. A new test must not destabilize
   * the file next to it. The three assertions read one rendered grid, so nothing
   * is lost but the per-assertion `it` boundary.
   */
  it("renders exactly the columns it can fill, and no seam-required column", () => {
    // Above the 768px card-fallback breakpoint, so the CSS grid renders and the
    // column headers exist to be asserted on at all.
    restoreContainerWidth = stubContainerWidthPx(1440);
    const { container } = render(
      <SessionsListSurfaceV2 rows={ROWS} usage={undefined} />
    );

    for (const columnId of SESSIONS_SEAM_REQUIRED_COLUMN_IDS) {
      expect(
        container.querySelector(`[data-column-id="${columnId}"]`)
      ).toBeNull();
    }

    // Guards the filter against over-reach: a predicate that dropped everything
    // would satisfy the assertion above while rendering an empty grid.
    for (const columnId of ["status", "owner", "autonomy", "repo"]) {
      expect(
        container.querySelector(`[data-column-id="${columnId}"]`)
      ).not.toBeNull();
    }

    // And the rendered set is EXACTLY the canonical default view — not a column
    // more, not one fewer.
    //
    // ISS-7262 changed this expectation deliberately, and this is the behaviour
    // change: the surface used to seed `visibleColumnIds` from every column its
    // menu offered, so an unseeded mount rendered all fourteen and the dropped
    // set was exactly the two seam-required ids. It now seeds from
    // `SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS`, the canonical default, which also
    // ships `pr`, `merge`, `started` and `updated` OFF — so a first screen is the
    // ten columns the product documents rather than four extra tracks on a grid
    // that already overflows.
    //
    // Asserted as an EQUALITY against the shared default rather than a relaxed
    // "the seam ids are absent", so this still fails a filter that over-reaches
    // and now also fails a regression back to seeding everything.
    // Narrowed to DATA columns against the canonical order: the grid also emits
    // the structural leading (session-name) column, which is not a data column
    // and is never in the default set.
    const rendered = new Set(
      Array.from(container.querySelectorAll("[data-column-id]"))
        .map((element) => element.getAttribute("data-column-id"))
        .filter(
          (id): id is string =>
            id !== null && SESSIONS_DATA_COLUMN_ORDER.includes(id)
        )
    );

    expect(rendered).toEqual(new Set(SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS));
    // The seam-required ids are in neither set — they are gated AND default-off,
    // so their absence above must not be read as the default set covering them.
    for (const columnId of SESSIONS_SEAM_REQUIRED_COLUMN_IDS) {
      expect(SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS).not.toContain(columnId);
    }
  });

  /**
   * A second mount, against the single-mount rule above, because it cannot share
   * one: the whole point is a DIFFERENT prop set — a host controller naming the
   * seam ids in `visibleColumnIds`.
   *
   * ISS-7262 made `visibleColumnIds` host-owned. While it was private the menu
   * was the only way in, so filtering the Show/Hide options was enough to keep
   * these columns off the grid. A controller can now name them directly, and a
   * column admitted that way would be doubly wrong: a full track of em dashes,
   * with no menu entry to switch it back off.
   */
  it("drops a seam-required column a controlling host asks for", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const { container } = render(
      <SessionsListSurfaceV2
        controlledView={{
          value: {
            sortBy: null,
            sortDir: "asc",
            grouping: EMPTY_TABLE_GROUPING,
            facets: DEFAULT_SESSION_FACET_FILTERS,
            dateRange: DEFAULT_DATE_RANGE,
            visibleColumnIds: new Set([
              "status",
              ...SESSIONS_SEAM_REQUIRED_COLUMN_IDS,
            ]),
            page: 0,
            scopeUserId: null,
          },
          onChange: () => undefined,
        }}
        rows={ROWS}
        usage={undefined}
      />
    );

    for (const columnId of SESSIONS_SEAM_REQUIRED_COLUMN_IDS) {
      expect(
        container.querySelector(`[data-column-id="${columnId}"]`)
      ).toBeNull();
    }
    // The positive sibling: the non-seam id in the same controlled set still
    // renders, so the assertions above cannot be satisfied by a surface that
    // dropped every column, or failed to mount at all.
    expect(container.querySelector('[data-column-id="status"]')).not.toBeNull();
  });
});
