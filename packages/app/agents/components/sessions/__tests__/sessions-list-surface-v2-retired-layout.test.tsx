import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { pinSessionFixtureClock } from "@repo/app/test/mocks/session-fixture-clock";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";
import type { SessionsListViewState } from "../sessions-list-view-state";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/**
 * ISS-8633 — the Board layout and its toolbar toggle are gone, and a view that
 * still names Board renders the List.
 *
 * Both halves matter. The absence alone is vacuous — a surface that failed to
 * mount passes it — so every case here asserts what the reader DOES get first:
 * the grid's own column headers, and the date-range control proving the toolbar
 * itself rendered.
 */

const ROW = createSessionTableRowFixture({
  id: "session-retired-layout",
  name: "agent/retired-layout",
  status: "Active",
});

const VISIBLE_COLUMN_IDS = new Set(["status", "model", "repo", "updated"]);

const VIEW: SessionsListViewState = {
  dateRange: DEFAULT_DATE_RANGE,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  grouping: EMPTY_TABLE_GROUPING,
  page: 0,
  scopeUserId: null,
  sortBy: null,
  sortDir: "asc",
  visibleColumnIds: VISIBLE_COLUMN_IDS,
};

/**
 * A view as it arrives from a store written before the axis was retired — a
 * saved view, a rehydrated param, an older host still spreading its own state.
 * Held in a VARIABLE and then widened, because excess-property checking would
 * reject the same shape written inline and the runtime case is the one under
 * test: an unknown key must be ignored, never render an empty surface.
 */
const STALE_BOARD_SHAPE = { ...VIEW, layout: "board" };
const STALE_BOARD_VIEW: SessionsListViewState = STALE_BOARD_SHAPE;

const ROW_LAYOUT_NAME = "Row layout";
const DATE_RANGE_NAME = "Filter by date range";

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

pinSessionFixtureClock();

function renderSurface(view: SessionsListViewState) {
  restoreContainerWidth = stubContainerWidthPx(1800);
  return render(
    <SessionsListSurfaceV2
      controlledView={{
        onChange: () => undefined,
        totalRows: 1,
        value: view,
      }}
      rows={[ROW]}
      usage={undefined}
    />
  );
}

describe("SessionsListSurfaceV2 after the Board layout was removed", () => {
  it("renders the List layout for a view still carrying a retired board layout", () => {
    const { container } = renderSurface(STALE_BOARD_VIEW);

    expect(screen.getByText("agent/retired-layout")).toBeVisible();
    // Column headers are positive evidence that the canonical List mounted;
    // the absence of the retired Board toggle alone would be vacuous.
    expect(
      container.querySelectorAll('[role="columnheader"]').length
    ).toBeGreaterThan(0);
  });

  it("offers no layout toggle on a toolbar that otherwise mounted", () => {
    renderSurface(VIEW);

    // The positive half: the toolbar really is on screen, so the absences below
    // are the removal rather than a surface that never rendered.
    expect(
      screen.getByRole("radiogroup", { name: DATE_RANGE_NAME })
    ).toBeVisible();
    // Asserted on the accessibility TREE, so an inert-but-visible control would
    // fail here too — the same standard the retired toggle's own test used.
    expect(
      screen.queryByRole("radiogroup", { name: ROW_LAYOUT_NAME })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: "Board view" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: "List view" })
    ).not.toBeInTheDocument();
  });
});
