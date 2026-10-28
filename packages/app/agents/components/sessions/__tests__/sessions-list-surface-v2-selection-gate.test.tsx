import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { TableBulkActionUndo } from "@repo/design-system/components/ui/table-bulk-actions";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import {
  queryGridDataRows,
  queryGridSelectableRows,
} from "@repo/design-system/lib/grid-table-v2-row-drag";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";
import type { SessionsListViewState } from "../sessions-list-view-state";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/**
 * ISS-9107 AC9 — selection exists to feed a bulk OPERATION.
 *
 * A host with neither `favorites` nor `bulkActions` used to still get the bulk
 * bar at two selected rows, carrying only its own "Clear selection" — an
 * affordance whose sole function is undoing itself. On the desktop shell, whose
 * v1 table has no row selection at all, turning `grid-table-v2` on therefore
 * ADDED a dead control. The operator ruled that out explicitly.
 *
 * Driven through a controlled `selection` rather than simulated clicks: the
 * branch under test is what the surface DOES with a selected set, and a test
 * that depended on the grid's pointer wiring would go green the moment that
 * wiring changed, while the dead bar came back.
 */

const ROWS = [
  createSessionTableRowFixture({ id: "ses-1", name: "agent/one" }),
  createSessionTableRowFixture({ id: "ses-2", name: "agent/two" }),
];

const SELECTED_BOTH = {
  onChange: () => {
    // controlled by the test, never moved by it
  },
  selectedIds: new Set(["ses-1", "ses-2"]),
};

const VIEW: SessionsListViewState = {
  dateRange: DEFAULT_DATE_RANGE,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  grouping: EMPTY_TABLE_GROUPING,
  page: 0,
  scopeUserId: null,
  search: "",
  sortBy: null,
  sortDir: "desc",
  visibleColumnIds: new Set(["status"]),
};

/** A host that HAS a selection model: the favorites half of the ISS-9107 test. */
const FAVORITES = {
  favoriteIds: new Set<string>(),
  isUnavailable: false,
  onChange: () => {
    // not under test
  },
};

/**
 * The OTHER half of the same verdict. `hasSelectionModel` is a disjunction —
 * favorites OR a non-empty bulk action list — and a gate driven only through
 * favorites would stay green for an implementation that had quietly narrowed to
 * `favorites != null`.
 */
/**
 * A minimal `TableBulkActionDescriptor`. `undo` arrived on `main` in ISS-10161
 * while this branch was open, so the merge compiled textually and failed at
 * `tsc` — the field is required on `TableBulkActionBase` and this fixture
 * predates it.
 *
 * `NotImplemented` rather than `Supported`: this action never runs (nothing here
 * asserts on `onSelect`), so claiming reversibility would be a claim the fixture
 * cannot honour, and that enum member exists precisely so a gap is not collapsed
 * into a deliberate refusal.
 */
const BULK_ACTIONS = [
  {
    icon: null,
    id: "archive",
    kind: "command" as const,
    label: "Archive",
    onSelect: () => {
      // not under test
    },
    undo: TableBulkActionUndo.NotImplemented,
  },
];

/**
 * The RAIL, named through its own `role="toolbar"` and accessible name. Matching
 * the sentence alone stopped being unambiguous with ISS-9574: the surface also
 * holds a visually hidden live region stating the same count, so a bare text
 * query answers "something says a count", which is not what either case here
 * means by "the bulk bar".
 */
const BULK_BAR_NAME = /sessions selected/;

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  cleanup();
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

function renderSurface(
  extra: Partial<React.ComponentProps<typeof SessionsListSurfaceV2>>
) {
  restoreContainerWidth = stubContainerWidthPx(1440);
  render(
    <SessionsListSurfaceV2
      controlledView={{
        onChange: () => {
          // not under test
        },
        totalRows: ROWS.length,
        value: VIEW,
      }}
      rows={ROWS}
      selection={SELECTED_BOTH}
      usage={undefined}
      {...extra}
    />
  );
}

describe("SessionsListSurfaceV2 selection gate (ISS-9107)", () => {
  it("renders no bulk bar for a host with no bulk action or favorites", () => {
    renderSurface({});

    expect(screen.queryByRole("toolbar", { name: BULK_BAR_NAME })).toBeNull();
  });

  // The positive sibling. Without it the assertion above would pass on a surface
  // that had lost the bulk bar entirely — which would be a regression for web,
  // the shell that DOES supply favorites.
  it("still renders the bulk bar once a host supplies favorites", () => {
    renderSurface({ favorites: FAVORITES });

    expect(screen.getByRole("toolbar", { name: BULK_BAR_NAME })).toBeVisible();
  });
});

/**
 * ISS-10528 — the same ISS-9107 verdict, one layer further down.
 *
 * `SessionsListGridV2` arms `GridTableV2`'s pointer range drag, and the
 * primitive's own guard cannot refuse a host that has no selection to resolve
 * one into: it tests `onRowRangeDrag != null`, and `suppressRowSelection` is a
 * no-op that is still non-null. So the gesture has to be withheld at the seam
 * below, and only a test driving the SURFACE can see the threading go missing —
 * a test that renders `SessionsListGridV2` directly arms whatever IT was handed
 * and stays green while the surface stops handing anything down.
 *
 * Both arms read the same attribute, in both states, so neither can pass on a
 * selector that matches nothing.
 */

/**
 * The grid's DATA rows. Chrome rows carry `[data-grid-row]` too since ISS-8930,
 * and counting them would make "the grid rendered" true of a body with no rows.
 */
function dataRows(): HTMLElement[] {
  return queryGridDataRows(document);
}

function selectableRows(): HTMLElement[] {
  return queryGridSelectableRows(document);
}

describe("SessionsListSurfaceV2 range-drag gate (ISS-10528)", () => {
  it("arms no row range drag for a host with no bulk action or favorites", () => {
    renderSurface({});

    expect(selectableRows()).toHaveLength(0);
    // Anti-vacuity: the rows themselves ARE painted, so the count above is the
    // gesture being withheld rather than an empty grid.
    expect(dataRows()).toHaveLength(ROWS.length);
  });

  it("still arms the row range drag once a host supplies favorites", () => {
    renderSurface({ favorites: FAVORITES });

    expect(selectableRows()).toHaveLength(ROWS.length);
  });

  it("arms it for a host whose selection feeds bulk actions instead", () => {
    renderSurface({ bulkActions: BULK_ACTIONS });

    expect(selectableRows()).toHaveLength(ROWS.length);
  });

  // The boundary the disjunction turns on. An EMPTY list is a host that named
  // the capability and shipped none of it, which is still nothing for a range to
  // feed — and it is the case a `bulkActions != null` regression would arm.
  it("arms none for a host whose bulk action list is empty", () => {
    renderSurface({ bulkActions: [] });

    expect(selectableRows()).toHaveLength(0);
    expect(dataRows()).toHaveLength(ROWS.length);
  });
});

/**
 * ISS-10528 — the same verdict again, one prop over from the range drag.
 *
 * `GridTableV2` renders `aria-selected` only where a predicate was SUPPLIED
 * (`isRowSelected ? isRowSelected(item) : undefined`). A host with no selection
 * model has no selected set, so supplying one makes every row announce
 * `aria-selected="false"` forever — the permanent accessibility-tree claim
 * `useListBulkSelection` already refuses for the live region, reached by a
 * different prop.
 *
 * Read off the DATA rows rather than by role: `GridTableV2`'s rows are divs
 * carrying grid semantics, and `getAllByRole("row")` also answers for the chrome
 * rows that have no selection state to announce either way.
 */
function rowsDeclaringSelection(): HTMLElement[] {
  return dataRows().filter((row) => row.hasAttribute("aria-selected"));
}

describe("SessionsListSurfaceV2 aria-selected gate (ISS-10528)", () => {
  it("declares no selection state for a host with no bulk action or favorites", () => {
    renderSurface({});

    expect(rowsDeclaringSelection()).toHaveLength(0);
    // Anti-vacuity, and the whole point of the case: the rows ARE painted, and
    // the surface was even handed a selection of both of them. The attribute is
    // absent because the predicate was withheld, not because there is no grid.
    expect(dataRows()).toHaveLength(ROWS.length);
  });

  // The positive sibling, on the same attribute. Without it the assertion above
  // passes on a surface that stopped announcing selection to anyone — which is
  // the regression for web, the shell that DOES supply favorites.
  it("still declares it once a host supplies favorites", () => {
    renderSurface({ favorites: FAVORITES });

    expect(rowsDeclaringSelection()).toHaveLength(ROWS.length);
    // Both fixture rows are in `SELECTED_BOTH`, so a live selection model has to
    // report them SELECTED. Asserting presence alone would pass on a predicate
    // rewired to a constant false — the very value this gate exists to stop
    // being announced permanently.
    for (const row of rowsDeclaringSelection()) {
      expect(row).toHaveAttribute("aria-selected", "true");
    }
  });

  it("declares it for a host whose selection feeds bulk actions instead", () => {
    renderSurface({ bulkActions: BULK_ACTIONS });

    expect(rowsDeclaringSelection()).toHaveLength(ROWS.length);
  });

  it("declares none for a host whose bulk action list is empty", () => {
    renderSurface({ bulkActions: [] });

    expect(rowsDeclaringSelection()).toHaveLength(0);
    expect(dataRows()).toHaveLength(ROWS.length);
  });
});
