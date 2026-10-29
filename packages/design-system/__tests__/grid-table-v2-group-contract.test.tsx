import {
  GridTableV2,
  type GridTableV2Column,
  type GridTableV2Group,
} from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * ISS-9335 — the three band facts a HOST owns that `GridTableV2` used to decide
 * for itself: what a band's count means, whether it is continued from an
 * earlier page, and who remembers that it is collapsed or that a row is open.
 *
 * Every case drives the rendered DOM. The defect each guards against is the
 * host's answer never REACHING the header — a prop accepted and dropped — which
 * asserting on the value passed in could never observe.
 */

type Row = { id: string; name: string; children?: Row[] };

const COLUMNS: GridTableV2Column[] = [{ id: "name", label: "Name" }];
const GRID_TEMPLATE = "minmax(200px, 1fr) 120px";
/** Any digit — a band header stating a count of any size. */
const ANY_DIGIT = /\d/;
/** The lead header control, whose name is the column label. */
const LEAD_LABEL_PATTERN = /Name/;
/** The "Name" item inside the opened lead sort menu. */
const NAME_OPTION_PATTERN = /Name/;

const ALPHA: Row = { id: "1", name: "Alpha" };
const BETA: Row = { id: "2", name: "Beta" };
const CHILD: Row = { id: "1a", name: "Alpha child" };
const ALPHA_WITH_CHILD: Row = { ...ALPHA, children: [CHILD] };

function renderGrid(
  props: Partial<React.ComponentProps<typeof GridTableV2<Row>>>
) {
  return render(
    <GridTableV2<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns={GRID_TEMPLATE}
      items={[]}
      leadingLabel="Name"
      renderCell={(_columnId, row) => `cell for ${row.id}`}
      renderLead={(row) => row.name}
      {...props}
    />
  );
}

function ControlledCollapseGrid({
  onRenderedItemsChange,
}: {
  onRenderedItemsChange: (items: readonly Row[]) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  return (
    <GridTableV2<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns={GRID_TEMPLATE}
      groupCollapse={{
        isCollapsed: (key) => collapsed.has(key),
        setCollapsed: (key, isCollapsed) => {
          const next = new Set(collapsed);
          if (isCollapsed) {
            next.add(key);
          } else {
            next.delete(key);
          }
          setCollapsed(next);
        },
      }}
      groups={[
        { items: [ALPHA], key: "active", label: "Active" },
        { items: [BETA], key: "done", label: "Done" },
      ]}
      items={[]}
      leadingLabel="Name"
      onRenderedItemsChange={onRenderedItemsChange}
      renderCell={(_columnId, row) => `cell for ${row.id}`}
      renderLead={(row) => row.name}
    />
  );
}

/** Radix opens its dropdown on pointerdown, not click. */
function openLeadSortMenu(name: RegExp) {
  fireEvent.pointerDown(screen.getByRole("button", { name }), {
    button: 0,
    ctrlKey: false,
  });
}

/** The band header button, whose accessible name folds in label and count. */
function bandHeader(label: string): HTMLElement {
  const header = screen
    .getAllByRole("button")
    .find((button) => button.textContent?.includes(label));
  if (!header) {
    throw new Error(`no band header for ${label}`);
  }
  return header;
}

describe("a band's count", () => {
  it("derives from its own rows when the host declares none", () => {
    renderGrid({
      groups: [{ items: [ALPHA, BETA], key: "active", label: "Active" }],
    });

    expect(bandHeader("Active").textContent).toContain("2");
  });

  it("states the host's population instead of the rows on this page", () => {
    // The paged case: two rows on screen, forty in the band. A header that
    // published `2` would be reporting the page as the population.
    renderGrid({
      groups: [
        { count: 40, items: [ALPHA, BETA], key: "active", label: "Active" },
      ],
    });

    expect(bandHeader("Active").textContent).toContain("40");
    expect(bandHeader("Active").textContent).not.toContain("2");
  });

  it("renders NO number when the host declares it cannot state one", () => {
    // `null` is the third state and the reason the field is nullable: a paged
    // host whose totals do not cover this band must not fall back to the page's
    // own length, which is exactly what an absent `count` would do.
    renderGrid({
      groups: [
        { count: null, items: [ALPHA, BETA], key: "active", label: "Active" },
      ],
    });

    expect(bandHeader("Active").textContent).not.toMatch(ANY_DIGIT);
  });

  it("stays suppressed by showGroupCounts even when the host declared one", () => {
    renderGrid({
      groups: [
        { count: 40, items: [ALPHA, BETA], key: "active", label: "Active" },
      ],
      showGroupCounts: false,
    });

    expect(bandHeader("Active").textContent).not.toMatch(ANY_DIGIT);
  });

  it("marks a band whose rows began on an earlier page", () => {
    renderGrid({
      groups: [
        {
          count: 40,
          isContinued: true,
          items: [ALPHA],
          key: "active",
          label: "Active",
        },
      ],
    });

    expect(bandHeader("Active").textContent).toContain("(continued)");
  });
});

describe("host-owned band collapse", () => {
  const GROUPS: GridTableV2Group<Row>[] = [
    { items: [ALPHA], key: "active", label: "Active" },
  ];

  it("paints a band the host reports collapsed, with no toggle of its own", () => {
    renderGrid({
      groupCollapse: { isCollapsed: () => true, setCollapsed: vi.fn() },
      groups: GROUPS,
    });

    expect(screen.queryByText("Alpha")).toBeNull();
  });

  it("reports a toggle to the host rather than remembering it", () => {
    const setCollapsed = vi.fn();
    renderGrid({
      groupCollapse: { isCollapsed: () => false, setCollapsed },
      groups: GROUPS,
    });

    fireEvent.click(bandHeader("Active"));

    expect(setCollapsed).toHaveBeenCalledWith("active", true);
    // The host said open and never changed its answer, so the band is still
    // open — the grid holds no second copy that could have closed it.
    expect(screen.getByText("Alpha")).toBeTruthy();
  });

  it("reports the post-collapse visible rows to the host", () => {
    const onRenderedItemsChange = vi.fn();
    render(
      <ControlledCollapseGrid onRenderedItemsChange={onRenderedItemsChange} />
    );
    onRenderedItemsChange.mockClear();

    fireEvent.click(bandHeader("Active"));

    expect(onRenderedItemsChange).toHaveBeenCalledWith([BETA]);
  });
});

describe("host-owned row expansion", () => {
  const GROUPS: GridTableV2Group<Row>[] = [
    { items: [ALPHA_WITH_CHILD], key: "active", label: "Active" },
  ];

  it("paints a row the host reports open, past the grid's own seed", () => {
    // `defaultExpandedRowIds` is deliberately empty AND contradicted: the port
    // wins, which is what lets a filter force an ancestor open after mount.
    renderGrid({
      defaultExpandedRowIds: [],
      getChildren: (row) => row.children,
      groups: GROUPS,
      rowExpansion: { isExpanded: () => true, setExpanded: vi.fn() },
    });

    expect(screen.getByText("Alpha child")).toBeTruthy();
  });

  it("reports a disclosure press to the host and notifies the change listener", () => {
    const setExpanded = vi.fn();
    const onRowExpandedChange = vi.fn();
    renderGrid({
      getChildren: (row) => row.children,
      groups: GROUPS,
      onRowExpandedChange,
      rowExpansion: { isExpanded: () => false, setExpanded },
    });

    fireEvent.click(screen.getByRole("button", { name: "Expand row" }));

    expect(setExpanded).toHaveBeenCalledWith("1", true);
    expect(onRowExpandedChange).toHaveBeenCalledWith(ALPHA_WITH_CHILD, true);
    // Still closed: the host's answer did not change, and the grid kept none.
    expect(screen.queryByText("Alpha child")).toBeNull();
  });

  it("drops descendants from the selection population when a parent collapses", () => {
    const onRenderedItemsChange = vi.fn();
    renderGrid({
      defaultExpandedRowIds: [ALPHA_WITH_CHILD.id],
      getChildren: (row) => row.children,
      groups: GROUPS,
      onRenderedItemsChange,
    });
    expect(onRenderedItemsChange).toHaveBeenLastCalledWith([
      ALPHA_WITH_CHILD,
      CHILD,
    ]);
    onRenderedItemsChange.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Collapse row" }));

    expect(screen.queryByText("Alpha child")).toBeNull();
    expect(onRenderedItemsChange).toHaveBeenLastCalledWith([ALPHA_WITH_CHILD]);
  });
});

describe("without the ports", () => {
  it("still owns band collapse in its own state", () => {
    renderGrid({
      groups: [{ items: [ALPHA], key: "active", label: "Active" }],
    });

    expect(screen.getByText("Alpha")).toBeTruthy();
    fireEvent.click(bandHeader("Active"));
    expect(screen.queryByText("Alpha")).toBeNull();
  });

  it("still seeds row expansion from defaultExpandedRowIds", () => {
    renderGrid({
      defaultExpandedRowIds: ["1"],
      getChildren: (row) => row.children,
      groups: [{ items: [ALPHA_WITH_CHILD], key: "active", label: "Active" }],
    });

    expect(screen.getByText("Alpha child")).toBeTruthy();
  });
});

describe("the lead header's own controls", () => {
  const GROUPS: GridTableV2Group<Row>[] = [
    { items: [ALPHA, BETA], key: "active", label: "Active" },
  ];

  it("renders no select-all checkbox for a table that declares none", () => {
    renderGrid({ groups: GROUPS });

    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("puts select-all in the lead header cell, claiming no track of its own", () => {
    renderGrid({ groups: GROUPS, onSelectAll: vi.fn(), showSelectAll: true });

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeTruthy();
    // Inside the identity `columnheader`, not a track beside it: a new track
    // would shift every column and every body cell one place right.
    expect(checkbox.closest('[data-column-id="__leading__"]')).toBeTruthy();
    expect(screen.getAllByRole("columnheader")).toHaveLength(
      COLUMNS.length + 1
    );
  });

  it("reports a select-all press, and reads its tri-state from the host", () => {
    const onSelectAll = vi.fn();
    const { rerender } = renderGrid({
      groups: GROUPS,
      onSelectAll,
      showSelectAll: true,
      someSelected: true,
    });

    expect(screen.getByRole("checkbox").getAttribute("data-state")).toBe(
      "indeterminate"
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onSelectAll).toHaveBeenCalledWith(true);

    rerender(
      <GridTableV2<Row>
        allSelected
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns={GRID_TEMPLATE}
        groups={GROUPS}
        items={[]}
        leadingLabel="Name"
        onSelectAll={onSelectAll}
        renderCell={(_columnId, row) => `cell for ${row.id}`}
        renderLead={(row) => row.name}
        showSelectAll
      />
    );
    expect(screen.getByRole("checkbox").getAttribute("data-state")).toBe(
      "checked"
    );
  });

  it("offers every lead sort key as a menu item, and cycles asc to desc to clear", () => {
    const onSort = vi.fn();
    const onClearSort = vi.fn();
    const options = [
      { key: "title", label: "Name" },
      { key: "status", label: "Status" },
      { key: "slug", label: "ID" },
    ];

    // Not the active key: the first press must ASK for ascending.
    const first = renderGrid({
      groups: GROUPS,
      leadingSortOptions: options,
      onClearSort,
      onSort,
      sortBy: "status",
    });
    openLeadSortMenu(LEAD_LABEL_PATTERN);
    fireEvent.click(
      screen.getByRole("menuitem", { name: NAME_OPTION_PATTERN })
    );
    expect(onSort).toHaveBeenCalledWith("title", "asc");
    first.unmount();

    // Active and ascending: the second press flips direction.
    const second = renderGrid({
      groups: GROUPS,
      leadingSortOptions: options,
      onClearSort,
      onSort,
      sortBy: "title",
      sortDir: "asc",
    });
    openLeadSortMenu(LEAD_LABEL_PATTERN);
    fireEvent.click(
      screen.getByRole("menuitem", { name: NAME_OPTION_PATTERN })
    );
    expect(onSort).toHaveBeenCalledWith("title", "desc");
    second.unmount();

    // Active and descending: the third press clears. This is the ONLY route to
    // clear-sort, which is why it is not a control of its own.
    renderGrid({
      groups: GROUPS,
      leadingSortOptions: options,
      onClearSort,
      onSort,
      sortBy: "title",
      sortDir: "desc",
    });
    openLeadSortMenu(LEAD_LABEL_PATTERN);
    fireEvent.click(
      screen.getByRole("menuitem", { name: NAME_OPTION_PATTERN })
    );
    expect(onClearSort).toHaveBeenCalledTimes(1);
  });

  it("announces the lead column's sort state from whichever option is active", () => {
    renderGrid({
      groups: GROUPS,
      leadingSortOptions: [
        { key: "title", label: "Name" },
        { key: "slug", label: "ID" },
      ],
      onSort: vi.fn(),
      sortBy: "slug",
      sortDir: "desc",
    });

    const lead = screen
      .getAllByRole("columnheader")
      .find((cell) => cell.getAttribute("data-column-id") === "__leading__");
    expect(lead?.getAttribute("aria-sort")).toBe("descending");
  });
});
