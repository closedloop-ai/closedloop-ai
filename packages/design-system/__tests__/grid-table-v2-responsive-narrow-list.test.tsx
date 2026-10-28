import {
  GRID_TABLE_V2_NARROW_LEADING_LABEL,
  GridTableV2,
  type GridTableV2Column,
  type GridTableV2Group,
} from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { GRID_TABLE_V2_LONG_PRESS_MS } from "@closedloop-ai/design-system/lib/grid-table-v2-constants";
import {
  GRID_TABLE_V2_NARROW_TEMPLATE,
  isGridTableV2NarrowMode,
  resolveGridTableV2Layout,
} from "@closedloop-ai/design-system/lib/grid-table-v2-responsive";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const ACTIVE_GROUP_NAME_PATTERN = /Active/;
const ADA_GROUP_NAME_PATTERN = /Ada/;
const ARCHIVED_GROUP_NAME_PATTERN = /Archived/;

type Row = {
  children?: Row[];
  id: string;
  name: string;
  owner: string;
  status: string;
};

const CHILD: Row = {
  id: "1a",
  name: "Alpha child",
  owner: "Ada",
  status: "Active",
};
const ROWS: Row[] = [
  {
    children: [CHILD],
    id: "1",
    name: "Alpha",
    owner: "Ada",
    status: "Active",
  },
  { id: "2", name: "Beta", owner: "Linus", status: "Draft" },
];
const COLUMNS: GridTableV2Column[] = [
  { id: "status", label: "Status" },
  { id: "owner", label: "Owner" },
];
const GRID_TEMPLATE = "minmax(200px, 1fr) 120px 160px";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderGrid({
  groups,
  mode = "compact",
  ...props
}: {
  groups?: GridTableV2Group<Row>[];
  mode?: "auto" | "compact" | "expanded";
} & Partial<React.ComponentProps<typeof GridTableV2<Row>>> = {}) {
  return render(
    <GridTableV2<Row>
      columns={COLUMNS}
      getChildren={(row) => row.children}
      getRowId={(row) => row.id}
      gridTemplateColumns={GRID_TEMPLATE}
      groups={groups}
      items={groups ? [] : ROWS}
      leadingLabel="Artifact"
      mode={mode}
      renderCell={(columnId, row) => row[columnId as "owner" | "status"]}
      renderLead={(row) => <span>{row.name}</span>}
      {...props}
    />
  );
}

describe("[DT-01][DT-02][DT-05] responsive narrow-list resolution", () => {
  it("resolves compact explicitly and auto below the canonical breakpoint", () => {
    expect(isGridTableV2NarrowMode("compact", false)).toBe(true);
    expect(isGridTableV2NarrowMode("auto", true)).toBe(true);
    expect(isGridTableV2NarrowMode("auto", false)).toBe(false);
    expect(isGridTableV2NarrowMode("expanded", true)).toBe(false);
  });

  it("removes non-name tracks, pins, and trailing chrome while retaining row utilities in the Name cell", () => {
    const narrow = resolveGridTableV2Layout({
      bodyHasLeadingUtility: true,
      columns: COLUMNS,
      foldFitWidth: 400,
      gridTemplateColumns: GRID_TEMPLATE,
      hasTrailingTrack: true,
      headerHasLeadingUtility: true,
      isContainerMeasured: true,
      isNarrowViewport: true,
      mode: "auto",
      pinLeadColumn: true,
      snapFoldToColumns: false,
    });
    expect(narrow).toMatchObject({
      hasLeadingUtilityTrack: false,
      isNarrow: true,
      paintsBodyUtility: true,
      paintsHeaderUtility: false,
      pinsLeadColumn: false,
      renderedColumns: [],
      renderedGridTemplateColumns: GRID_TABLE_V2_NARROW_TEMPLATE,
      rendersTrailingTrack: false,
    });

    const wide = resolveGridTableV2Layout({
      bodyHasLeadingUtility: true,
      columns: COLUMNS,
      foldFitWidth: 900,
      gridTemplateColumns: GRID_TEMPLATE,
      hasTrailingTrack: true,
      headerHasLeadingUtility: true,
      isContainerMeasured: true,
      isNarrowViewport: false,
      mode: "auto",
      pinLeadColumn: true,
      snapFoldToColumns: false,
    });
    expect(wide).toMatchObject({
      hasLeadingUtilityTrack: true,
      isNarrow: false,
      paintsBodyUtility: true,
      paintsHeaderUtility: true,
      pinsLeadColumn: true,
      renderedColumns: COLUMNS,
      renderedGridTemplateColumns: GRID_TEMPLATE,
      rendersTrailingTrack: true,
    });

    const narrowOnlyUtility = resolveGridTableV2Layout({
      bodyHasLeadingUtility: true,
      bodyUtilityInWide: false,
      columns: COLUMNS,
      foldFitWidth: 900,
      gridTemplateColumns: GRID_TEMPLATE,
      hasTrailingTrack: false,
      headerHasLeadingUtility: false,
      isContainerMeasured: true,
      isNarrowViewport: false,
      mode: "auto",
      pinLeadColumn: true,
      snapFoldToColumns: false,
    });
    expect(narrowOnlyUtility).toMatchObject({
      hasLeadingUtilityTrack: false,
      paintsBodyUtility: false,
      pinsLeadColumn: true,
      renderedGridTemplateColumns: GRID_TEMPLATE,
    });
  });
});

describe("[DT-02][DT-03][DT-04] canonical one-column projection", () => {
  it("renders Name and identity cells only and allows containment", () => {
    renderGrid();

    const grid = screen.getByRole("treegrid");
    expect(grid).toHaveAttribute("aria-colcount", "1");
    expect(grid).toHaveClass("w-full", "min-w-0");
    expect(grid).not.toHaveClass("min-w-fit");
    expect(screen.getAllByRole("columnheader")).toHaveLength(1);
    expect(screen.getByRole("columnheader")).toHaveTextContent(
      GRID_TABLE_V2_NARROW_LEADING_LABEL
    );
    expect(screen.queryByText("Status")).toBeNull();
    expect(screen.queryByText("Owner")).toBeNull();
    expect(screen.queryByText("retired card Alpha")).toBeNull();

    for (const row of ROWS) {
      const rendered = document.querySelector<HTMLElement>(
        `[data-grid-row-id="${row.id}"]`
      );
      if (!rendered) {
        throw new Error(`Missing grid row ${row.id}`);
      }
      expect(within(rendered).getAllByRole("gridcell")).toHaveLength(1);
      expect(rendered).toHaveStyle({
        gridTemplateColumns: GRID_TABLE_V2_NARROW_TEMPLATE,
      });
    }
  });

  it("keeps favorite and select-all controls reachable inside the single Name column", () => {
    const onFavorite = vi.fn();
    const onRowSelectionToggle = vi.fn();
    const onSelectAll = vi.fn();
    renderGrid({
      isRowSelected: (row) => row.id === ROWS[0]?.id,
      leadingUtilityHeader: <span>Favorite</span>,
      onRowSelectionToggle,
      onSelectAll,
      renderLeadingUtility: (row) => (
        <button onClick={() => onFavorite(row.id)} type="button">
          {`Favorite ${row.name}`}
        </button>
      ),
      showSelectAll: true,
    });

    expect(screen.getAllByRole("columnheader")).toHaveLength(1);
    expect(screen.getByRole("columnheader")).toHaveTextContent(
      GRID_TABLE_V2_NARROW_LEADING_LABEL
    );
    expect(screen.getAllByRole("gridcell")).not.toHaveLength(0);
    expect(screen.getByRole("checkbox", { name: "Deselect row" })).toHaveClass(
      "size-6"
    );

    fireEvent.click(screen.getByRole("button", { name: "Favorite Alpha" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Deselect row" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));

    expect(onFavorite).toHaveBeenCalledWith(ROWS[0]?.id);
    expect(onRowSelectionToggle).toHaveBeenCalledWith(ROWS[0]);
    expect(onSelectAll).toHaveBeenCalledWith(true);
  });

  it("places an optional trailing action after the narrow lead and utility only", () => {
    const onAction = vi.fn();
    const { rerender } = renderGrid({
      renderLeadingUtility: (row) => <span>{`Utility ${row.id}`}</span>,
      renderNarrowTrailingAction: (row) => (
        <button onClick={() => onAction(row.id)} type="button">
          {`More ${row.id}`}
        </button>
      ),
    });
    const row = document.querySelector<HTMLElement>('[data-grid-row-id="1"]');
    if (!row) {
      throw new Error("Missing grid row 1");
    }
    const lead = within(row).getByRole("gridcell");
    expect(lead.textContent?.startsWith("AlphaUtility 1More 1")).toBe(true);
    fireEvent.click(within(row).getByRole("button", { name: "More 1" }));
    expect(onAction).toHaveBeenCalledWith("1");

    rerender(
      <GridTableV2<Row>
        columns={COLUMNS}
        getRowId={(item) => item.id}
        gridTemplateColumns={GRID_TEMPLATE}
        items={ROWS}
        leadingLabel="Artifact"
        mode="expanded"
        renderCell={(columnId, item) => item[columnId as "owner" | "status"]}
        renderLead={(item) => item.name}
        renderNarrowTrailingAction={(item) => <span>{`More ${item.id}`}</span>}
      />
    );
    expect(screen.queryByText("More 1")).toBeNull();
  });

  it("routes a coarse touch hold through narrow-row selection exactly once", () => {
    vi.useFakeTimers();
    const onRowClick = vi.fn();
    const onRowSelectionToggle = vi.fn();
    renderGrid({ onRowClick, onRowSelectionToggle });

    const row = document.querySelector<HTMLElement>(
      `[data-grid-row-id="${ROWS[0]?.id}"]`
    );
    if (!row) {
      throw new Error("Missing coarse-pointer row");
    }
    fireEvent.pointerDown(row, {
      clientX: 8,
      clientY: 8,
      pointerId: 1,
      pointerType: "touch",
    });
    act(() => vi.advanceTimersByTime(GRID_TABLE_V2_LONG_PRESS_MS));
    fireEvent.pointerUp(row, { pointerId: 1, pointerType: "touch" });
    fireEvent.click(row);

    expect(onRowSelectionToggle).toHaveBeenCalledTimes(1);
    expect(onRowSelectionToggle).toHaveBeenCalledWith(ROWS[0]);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("preserves the full column lattice outside the narrow viewport", () => {
    stubNarrowViewport(false);
    renderGrid({ mode: "auto" });

    const grid = screen.getByRole("treegrid");
    expect(grid).toHaveAttribute("aria-colcount", "3");
    expect(grid).toHaveClass("min-w-fit");
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    expect(
      screen.getByRole("columnheader", { name: "Artifact" })
    ).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Owner" })).toBeVisible();
    expect(screen.getByText("Ada")).toBeVisible();
  });
});

describe("[DT-07][DT-08][DT-09] shared grouped, tree, and after-row mechanics", () => {
  it("keeps nested and empty group headers full-width and independently collapsible", () => {
    const first = ROWS[0];
    const second = ROWS[1];
    if (!(first && second)) {
      throw new Error("Expected grouped fixture rows");
    }
    renderGrid({
      groups: [
        {
          items: ROWS,
          key: "active",
          label: "Active",
          subgroups: [
            { items: [first], key: "ada", label: "Ada" },
            { items: [second], key: "linus", label: "Linus" },
          ],
        },
        { items: [], key: "archived", label: "Archived" },
      ],
    });

    const active = screen.getByRole("button", {
      name: ACTIVE_GROUP_NAME_PATTERN,
    });
    const ada = screen.getByRole("button", { name: ADA_GROUP_NAME_PATTERN });
    const archived = screen.getByRole("button", {
      name: ARCHIVED_GROUP_NAME_PATTERN,
    });
    expect(active.closest('[role="gridcell"]')).toHaveAttribute(
      "aria-colspan",
      "1"
    );
    expect(archived).toHaveTextContent("0");
    for (const rowgroup of screen.getAllByRole("rowgroup")) {
      expect(rowgroup.querySelector('[role="rowgroup"]')).toBeNull();
      expect(rowgroup.querySelector('[role="row"]')).not.toBeNull();
    }
    fireEvent.click(ada);
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("Beta")).toBeVisible();
  });

  it("preserves tree disclosure and every after-row slot in the narrow projection", () => {
    const grouped = renderGrid({
      defaultExpandedRowIds: [ROWS[0]?.id ?? ""],
      renderAfterGroup: (group) => <span>{`after group ${group.key}`}</span>,
      renderAfterItem: (row) => <span>{`after item ${row.id}`}</span>,
      groups: [{ items: ROWS, key: "all", label: "All" }],
    });

    expect(screen.getByText(CHILD.name)).toBeVisible();
    expect(screen.getByRole("button", { name: "Collapse row" })).toBeVisible();
    expect(screen.getByText("after item 1")).toBeVisible();
    expect(screen.getByText("after item 1a")).toBeVisible();
    expect(screen.getByText("after item 2")).toBeVisible();
    expect(screen.getByText("after group all")).toBeVisible();

    grouped.unmount();
    renderGrid({ renderAfterRows: <span>after all rows</span> });
    expect(screen.getByText("after all rows")).toBeVisible();
  });
});

function stubNarrowViewport(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(
      (query: string): MediaQueryList => ({
        addEventListener: () => undefined,
        addListener: () => undefined,
        dispatchEvent: () => true,
        matches,
        media: query,
        onchange: null,
        removeEventListener: () => undefined,
        removeListener: () => undefined,
      })
    )
  );
}

describe("[DT-12] selected population production wiring", () => {
  it("uses a hidden descendant selection so a touch tap toggles instead of activating", () => {
    const onActivate = vi.fn();
    const onToggle = vi.fn();
    renderGrid({
      groups: [{ items: ROWS, key: "root", label: "Root" }],
      isRowSelected: (row) => row.id === CHILD.id,
      onRowClick: onActivate,
      onRowSelectionToggle: onToggle,
    });
    const disclosure = screen.getByRole("button", { name: "Expand row" });
    expect(screen.queryByText(CHILD.name)).toBeNull();
    const visibleRow = document.querySelector<HTMLElement>(
      `[data-grid-row-id="${ROWS[1]?.id}"]`
    );
    if (!visibleRow) {
      throw new Error("Missing visible row");
    }
    fireEvent.pointerDown(visibleRow, {
      pointerId: 1,
      pointerType: "touch",
    });
    fireEvent.pointerUp(visibleRow, {
      pointerId: 1,
      pointerType: "touch",
    });
    fireEvent.click(visibleRow);

    expect(disclosure).not.toHaveAttribute("aria-expanded");
    expect(
      document.querySelector(`[data-grid-row-id="${ROWS[0]?.id}"]`)
    ).toHaveAttribute("aria-expanded", "false");
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(ROWS[1]);
    expect(onActivate).not.toHaveBeenCalled();
  });
});
