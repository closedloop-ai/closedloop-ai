import { ProductGridTableV2 } from "@repo/app/shared/components/product-grid-table-v2";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  COLUMN_IDS,
  type ColumnId,
  useTestView,
} from "@repo/app/shared/hooks/__tests__/persisted-table-view-state.test-support";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { GRID_TABLE_V2_NARROW_LEADING_LABEL } from "@repo/design-system/components/ui/grid-table-v2";
import { GRID_TABLE_V2_NARROW_TEMPLATE } from "@repo/design-system/lib/grid-table-v2-responsive";
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

/**
 * ISS-9522 (PRD-727 phase 06, preference and compatibility). The responsive
 * layout is code-owned: `ProductGridTableV2` derives it from the viewport and
 * no stored field selects it. These cases drive the real persisted view hook
 * into the real flag-on product grid, so a stored arrangement that is corrupt,
 * names removed columns, or was written by a newer build cannot change the
 * phone-width projection, cannot hide a row's identity, and loses nothing on
 * the next write.
 */

type Row = { id: string; name: string };

const ROWS: Row[] = [
  { id: "row-1", name: "Alpha" },
  { id: "row-2", name: "Beta" },
];
const COLUMN_LABELS: Record<ColumnId, string> = {
  a: "Owner",
  b: "Status",
  c: "Updated",
};
const STORAGE_KEY = "test:view:web";
const DEFAULT_TRACK_WIDTH_PX = 120;
const NARROW_VIEWPORT_PX = 390;
const WIDE_VIEWPORT_PX = 1280;
/** A field no build of this table writes, standing in for a newer build's axis. */
const NEWER_BUILD_FIELD = "responsiveLayout";
const NEWER_BUILD_VALUE = { mode: "compact", version: 2 };

const originalVisualViewport = Object.getOwnPropertyDescriptor(
  globalThis.window,
  "visualViewport"
);

afterEach(() => {
  localStorage.clear();
  if (originalVisualViewport) {
    Object.defineProperty(
      globalThis.window,
      "visualViewport",
      originalVisualViewport
    );
    return;
  }
  Reflect.deleteProperty(globalThis.window, "visualViewport");
});

describe("ISS-9522 stored view against the responsive product grid", () => {
  it("paints the one-column list at phone width whatever the stored widths say", () => {
    installVisualViewport(NARROW_VIEWPORT_PX);
    seedStoredView({ columnWidths: { a: 9000, b: 4000, c: 6000 } });

    renderStoredViewGrid();

    expect(screen.getAllByRole("columnheader")).toHaveLength(1);
    expect(
      screen.getByRole("columnheader", {
        name: GRID_TABLE_V2_NARROW_LEADING_LABEL,
      })
    ).toBeVisible();
    for (const row of gridRows()) {
      expect(row.style.gridTemplateColumns).toBe(GRID_TABLE_V2_NARROW_TEMPLATE);
    }
  });

  it("recovers from corrupt stored values instead of applying them", () => {
    installVisualViewport(WIDE_VIEWPORT_PX);
    seedStoredView({
      columnOrder: ["c", "c", "a", "c", "b"],
      columnWidths: { a: -40, b: 1e9, c: "wide" },
    });

    renderStoredViewGrid();

    expect(columnHeaderNames()).toEqual([
      "Artifact",
      "Updated",
      "Owner",
      "Status",
    ]);
    const template = gridRows()[0]?.style.gridTemplateColumns;
    expect(template).toBe(
      `minmax(12rem, 1fr) ${DEFAULT_TRACK_WIDTH_PX}px ${DEFAULT_TRACK_WIDTH_PX}px ${DEFAULT_TRACK_WIDTH_PX}px`
    );
    const written = readStoredView();
    expect(written.columnWidths).toEqual({});
    expect(written.columnOrder).toEqual(["c", "a", "b"]);
  });

  it("keeps every row's identity reachable when stored ids hide or name removed columns", () => {
    seedStoredView({
      columnOrder: ["removed-column", "b"],
      hiddenColumns: ["a", "b", "c", "removed-column"],
    });

    installVisualViewport(WIDE_VIEWPORT_PX);
    const wide = renderStoredViewGrid();
    expect(columnHeaderNames()).toEqual(["Artifact"]);
    expect(unnamedRows()).toEqual([]);
    wide.unmount();

    installVisualViewport(NARROW_VIEWPORT_PX);
    renderStoredViewGrid();
    expect(columnHeaderNames()).toEqual([GRID_TABLE_V2_NARROW_LEADING_LABEL]);
    expect(unnamedRows()).toEqual([]);
    expect(readStoredView().hiddenColumns).toContain("removed-column");
  });

  it("ignores a newer build's field for layout and carries it through the next write", () => {
    installVisualViewport(WIDE_VIEWPORT_PX);
    seedStoredView({ [NEWER_BUILD_FIELD]: NEWER_BUILD_VALUE });

    const { result } = renderStoredViewGrid();

    expect(columnHeaderNames()).toEqual([
      "Artifact",
      "Owner",
      "Status",
      "Updated",
    ]);
    act(() => result.toggleColumn("b"));

    expect(columnHeaderNames()).toEqual(["Artifact", "Owner", "Updated"]);
    const written = readStoredView();
    expect(written.hiddenColumns).toEqual(["b"]);
    expect(written[NEWER_BUILD_FIELD]).toEqual(NEWER_BUILD_VALUE);
  });

  it("falls back to the code-owned default when the stored record is not JSON", () => {
    installVisualViewport(NARROW_VIEWPORT_PX);
    localStorage.setItem(STORAGE_KEY, "{not json");

    renderStoredViewGrid();

    expect(columnHeaderNames()).toEqual([GRID_TABLE_V2_NARROW_LEADING_LABEL]);
    expect(unnamedRows()).toEqual([]);
  });
});

function StoredViewGrid({
  onView,
}: {
  onView: (view: ReturnType<typeof useTestView>) => void;
}) {
  const view = useTestView("web");
  onView(view);
  const visible = orderColumns(view.columnOrder).filter((id) =>
    view.visibleColumns.has(id)
  );
  const tracks = visible.map(
    (id) => `${view.columnWidths[id] ?? DEFAULT_TRACK_WIDTH_PX}px`
  );
  return (
    <ProductGridTableV2<Row>
      columns={visible.map((id) => ({ id, label: COLUMN_LABELS[id] }))}
      getRowId={(row) => row.id}
      gridTemplateColumns={["minmax(12rem, 1fr)", ...tracks].join(" ")}
      items={ROWS}
      leadingLabel="Artifact"
      renderCell={(columnId) => COLUMN_LABELS[columnId as ColumnId]}
      renderLead={(row) => row.name}
    />
  );
}

function renderStoredViewGrid() {
  const handle: { result: ReturnType<typeof useTestView> | null } = {
    result: null,
  };
  const rendered = render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
      })}
    >
      <StoredViewGrid
        onView={(view) => {
          handle.result = view;
        }}
      />
    </FeatureFlagAdapterProvider>
  );
  return {
    get result() {
      if (handle.result === null) {
        throw new Error("StoredViewGrid has not rendered");
      }
      return handle.result;
    },
    unmount: rendered.unmount,
  };
}

function orderColumns(order: readonly string[]): ColumnId[] {
  const ordered = COLUMN_IDS.filter((id) => order.includes(id)).sort(
    (left, right) => order.indexOf(left) - order.indexOf(right)
  );
  return [...ordered, ...COLUMN_IDS.filter((id) => !ordered.includes(id))];
}

function seedStoredView(view: Record<string, unknown>) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      hiddenColumns: [],
      sortDir: "asc",
      sortKey: "name",
      ...view,
    })
  );
}

function readStoredView(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
}

function columnHeaderNames(): string[] {
  return screen
    .getAllByRole("columnheader")
    .map((header) => header.textContent ?? "");
}

function gridRows(): HTMLElement[] {
  return screen
    .getAllByRole("row")
    .filter((row) => within(row).queryAllByRole("gridcell").length > 0);
}

/** Names of the fixture rows the rendered grid does not show. */
function unnamedRows(): string[] {
  return ROWS.map((row) => row.name).filter(
    (name) => screen.queryByText(name) === null
  );
}

function installVisualViewport(width: number) {
  const viewport = Object.assign(new EventTarget(), { width });
  Object.defineProperty(globalThis.window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
  return viewport;
}
