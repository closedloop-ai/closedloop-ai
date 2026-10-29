import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { resolveListSurfacePagination } from "@repo/app/shared/lib/list-surface-pagination";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";
import type { SessionsListViewState } from "../sessions-list-view-state";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/**
 * ISS-9556 — the RENDER-COST budget for the Sessions list surface.
 *
 * Nothing on this path is memoized: no row, cell, or grid component is wrapped
 * in `React.memo`, and the surface hands the grid freshly-built arrays and
 * closures on every pass. So one surplus pass of THIS component re-renders every
 * row and every cell below it — render work is `passes x rows x columns`, and
 * the pass count is the only one of those three this component controls.
 *
 * No existing test covers that dimension. Twenty-one suites mount this surface
 * and all of them assert on rendered OUTPUT, which an extra pass leaves
 * identical. A `useEffect` that sets state on mount, or a tick that cascades
 * into a second pass, is invisible to every one of them.
 */

/**
 * The render counter.
 *
 * `resolveListSurfacePagination` is called once per execution of the surface's
 * function body, outside every `useMemo`, so its call count IS the surface's
 * render-pass count.
 *
 * Counting passes rather than React commits is what makes this budget able to
 * fail. A `<Profiler>` commit count does NOT work here: React batches sibling
 * state updates, so an added mount-time `setState` lands inside a commit that
 * already exists and moves no commit count at all — verified against this exact
 * surface — while still costing a full extra pass over every row.
 */
vi.mock("@repo/app/shared/lib/list-surface-pagination", async (original) => {
  const actual =
    await original<
      typeof import("@repo/app/shared/lib/list-surface-pagination")
    >();
  return {
    ...actual,
    resolveListSurfacePagination: vi.fn(actual.resolveListSurfacePagination),
  };
});

/**
 * A full default page, and a token page an order of magnitude smaller. Both are
 * measured so the budget can say the cost is flat in the page, not merely small
 * at one size.
 */
const REPRESENTATIVE_ROWS = 50;
const TOKEN_ROWS = 5;
const REPRESENTATIVE_COLUMN_IDS = [
  "status",
  "harness",
  "cost",
  "duration",
  "started",
  "lastActivity",
];

/**
 * Passes to put a page on screen from a cold mount, at ANY page size. One: the
 * surface resolves its rows during its first render and settles.
 */
const MOUNT_RENDER_BUDGET = 1;

/**
 * `stubContainerWidthPx` fires its `ResizeObserver` callback synchronously from
 * `observe()`, so any width-driven pass is already inside the mount baseline
 * above. If this budget ever reddens, that resize-driven pass is the real
 * signal — do not "fix" it by suppressing the measurement.
 */

/**
 * Passes an hourly `useCoarseNow` tick costs. One: the tick re-dates the
 * relative window and nothing it touches schedules further work. A second would
 * mean the pass triggered another, which at this fan-out is a render storm.
 */
const TICK_RENDER_BUDGET = 1;

/**
 * Passes a page turn costs. Paging and re-sorting are the highest-frequency
 * interactions on this surface, so they are where an effect that re-runs until
 * some per-row measurement settles would actually be felt.
 */
const PAGE_TURN_RENDER_BUDGET = 1;

/** The surface's date-window tick, driven here through fake timers. */
const ONE_HOUR_MS = 60 * 60 * 1000;

const NOW = new Date("2026-05-20T18:00:00.000Z");

const VIEW: SessionsListViewState = {
  dateRange: DEFAULT_DATE_RANGE,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  grouping: EMPTY_TABLE_GROUPING,
  page: 0,
  scopeUserId: null,
  search: "",
  sortBy: null,
  sortDir: "desc",
  visibleColumnIds: new Set(REPRESENTATIVE_COLUMN_IDS),
};

const renderPasses = vi.mocked(resolveListSurfacePagination);

let restoreContainerWidth: (() => void) | null = null;

beforeEach(() => {
  renderPasses.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  restoreContainerWidth?.();
  restoreContainerWidth = null;
  vi.useRealTimers();
});

function buildRows(count: number) {
  return Array.from({ length: count }, (_unused, index) =>
    createSessionTableRowFixture({
      id: `ses-${String(index).padStart(4, "0")}`,
      name: `agent/session-${index}`,
    })
  );
}

/**
 * `controlledView.totalRows` is deliberately NOT supplied: providing it puts the
 * surface in server-driven mode, which passes `enabled: false` to `useCoarseNow`
 * and removes the timer the second test exists to bound. A test that set it
 * would measure a surface with no tick and pass whatever the tick costs.
 */
function surfaceAt(rowCount: number, view: SessionsListViewState = VIEW) {
  return (
    <SessionsListSurfaceV2
      controlledView={{
        onChange: () => {
          // not under test
        },
        value: view,
      }}
      rows={buildRows(rowCount)}
      selection={undefined}
      usage={undefined}
    />
  );
}

function mountSurface(rowCount: number) {
  restoreContainerWidth = stubContainerWidthPx(1440);
  return render(surfaceAt(rowCount));
}

describe("ISS-9556 — Sessions list render budget", () => {
  it("mounts a full page in the same render passes as a token one", () => {
    mountSurface(TOKEN_ROWS);
    const tokenPasses = renderPasses.mock.calls.length;
    expect(tokenPasses).toBe(MOUNT_RENDER_BUDGET);

    cleanup();
    restoreContainerWidth?.();
    renderPasses.mockClear();

    mountSurface(REPRESENTATIVE_ROWS);

    // Ten times the rows for the same number of full-surface passes. The pinned
    // literal catches a new pass; this equality catches the case a literal
    // cannot describe on its own — a pass count that depends on the page, such
    // as an effect re-running until a per-row measurement settles.
    expect(renderPasses.mock.calls.length).toBe(tokenPasses);
    expect(renderPasses.mock.calls.length).toBe(MOUNT_RENDER_BUDGET);
  });

  it("spends one render pass on a page turn", () => {
    const { rerender } = mountSurface(REPRESENTATIVE_ROWS);
    renderPasses.mockClear();

    act(() => {
      rerender(surfaceAt(REPRESENTATIVE_ROWS, { ...VIEW, page: 1 }));
    });

    expect(renderPasses.mock.calls.length).toBe(PAGE_TURN_RENDER_BUDGET);
  });

  it("spends a fixed number of render passes on a date-window tick, and none between ticks", () => {
    mountSurface(REPRESENTATIVE_ROWS);
    renderPasses.mockClear();

    act(() => {
      vi.advanceTimersByTime(ONE_HOUR_MS);
    });
    expect(renderPasses.mock.calls.length).toBe(TICK_RENDER_BUDGET);

    // The negative half: the surface must be idle between ticks. Without it a
    // component that re-rendered on every timer turn would still satisfy the
    // assertion above on the tick that happens to be measured.
    renderPasses.mockClear();
    act(() => {
      vi.advanceTimersByTime(ONE_HOUR_MS / 2);
    });
    expect(renderPasses.mock.calls.length).toBe(0);
  });
});
