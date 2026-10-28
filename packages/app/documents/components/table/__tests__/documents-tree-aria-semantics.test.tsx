import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import type { DisplayGroup } from "@repo/app/documents/components/table/document-tree";
import { documentTreeRoots } from "@repo/app/documents/lib/documents-grid-groups";
import { DocumentColumn as Col } from "@repo/app/shared/hooks/use-column-visibility";
import {
  makeArtifact,
  makePlanArtifact,
} from "@repo/app/shared/test-fixtures/documents";
import { ariaTableProps } from "@repo/design-system/lib/grid-table-aria";
import { GRID_NAV_CELL_ROLE } from "@repo/design-system/lib/grid-table-navigation";
import axe from "axe-core";
import { getDocumentTableColumnCount } from "../document-row";
import { DocumentsGridGroupsBody } from "../documents-grid-groups-body";
import { DocumentsUngroupedTreeBody } from "../documents-ungrouped-tree-body";
import { DocumentTableHeader } from "../table-header";

/**
 * ISS-4761: the Documents tree was the last production caller opted OUT of the
 * shared `GridTable` ARIA table semantics (ISS-4672), so `/<org>/documents`
 * announced a body cell as a loose "Active" where every other dense table says
 * "Status, Active".
 *
 * Mirrors `packages/app/shared/lib/__tests__/grid-table-aria-semantics.test.tsx`:
 * the assertions pin the STRUCTURE (which element owns which) rather than the
 * mere presence of a role somewhere in the DOM, because a role that is present
 * but not owned by its required parent announces nothing. The tree's own
 * wrinkles — nested/tree rows, collapsible group sections, and the trailing
 * More-menu track this table has but `GridTable` does not — are what this file
 * adds on top.
 */
const VISIBLE_COLUMNS = [Col.Type, Col.Priority, Col.Updated];
// Lead (Name) track + the three data columns + the trailing More-menu track.
const COLUMN_COUNT = 5;
const HEADER_ROW_COUNT = 1;

/**
 * The same scoped rule set the design-system suite uses: the role hierarchy
 * itself (a `cell` must be owned by a `row`, a `row` by a `table`/`rowgroup`)
 * plus the validity of the index/span attributes that pair a cell to its column
 * header. axe traverses through role-less wrapper divs the way a browser's
 * accessibility tree does, so the explicit `parentElement` assertions below
 * cover the half it cannot.
 */
const ARIA_STRUCTURE_RULES = [
  "aria-allowed-attr",
  "aria-allowed-role",
  "aria-required-children",
  "aria-required-parent",
  "aria-valid-attr-value",
];

function noop() {
  // Sorting is asserted through the rendered header, never by invoking it.
}

function makeRootItem(id: string): DocumentRowItem {
  return {
    data: makeArtifact({ id, slug: id, title: `Root ${id}` }),
    kind: "document",
  };
}

function makeChildItem(id: string): DocumentRowItem {
  return {
    data: makePlanArtifact({ id, slug: id, title: `Child ${id}` }),
    kind: "document",
  };
}

function nestedGroup(): DisplayGroup {
  return {
    children: [makeChildItem("PLN-1"), makeChildItem("PLN-2")],
    groupKey: "ISS-1",
    root: makeRootItem("ISS-1"),
  } as DisplayGroup;
}

function DocumentsSelectionHarness() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(["ISS-1", "ISS-2"])
  );
  const groups = [
    {
      count: null,
      items: documentTreeRoots([nestedGroup()]),
      key: "features",
      label: "Features",
    },
    {
      count: null,
      items: [makeRootItem("ISS-2")],
      key: "plans",
      label: "Plans",
    },
  ];
  return (
    <>
      <output data-testid="selected-document-ids">
        {[...selectedIds].sort().join(",")}
      </output>
      <DocumentsGridGroupsBody
        allSelected={false}
        groupCollapse={{
          isCollapsed: (key) => collapsed.has(key),
          setCollapsed: (key, isCollapsed) =>
            setCollapsed((current) => {
              const next = new Set(current);
              if (isCollapsed) {
                next.add(key);
              } else {
                next.delete(key);
              }
              return next;
            }),
        }}
        groups={groups}
        isNested
        leadingSortOptions={[]}
        onClearSort={noop}
        onRenderedItemsChange={(items) =>
          setSelectedIds((current) => {
            const visible = new Set(items.map((item) => item.data.id));
            return new Set([...current].filter((id) => visible.has(id)));
          })
        }
        onSelectAll={noop}
        onSelectionChange={noop}
        onSort={noop}
        parentMap={new Map()}
        renderRowActions={() => null}
        rowExpansion={{ isExpanded: () => true, setExpanded: noop }}
        selectedIds={selectedIds}
        selectMode
        showCheckbox
        someSelected={false}
        sortBy={null}
        sortDir="asc"
        visibleColumns={VISIBLE_COLUMNS}
      />
    </>
  );
}

/**
 * The production composition: the shared header, the caller-owned `role="table"`
 * wrapper, and the tree's own row renderer — the three that have to agree, and
 * that a test rendering only one of them would never catch drifting apart.
 */
function renderTree({
  insideAriaTable = true,
  grouped = false,
}: {
  insideAriaTable?: boolean;
  grouped?: boolean;
} = {}) {
  const columnCount = getDocumentTableColumnCount(VISIBLE_COLUMNS.length);
  const rows = (
    <DocumentsUngroupedTreeBody
      insideAriaTable={insideAriaTable}
      isExpanded={() => true}
      items={documentTreeRoots([nestedGroup()])}
      parentMap={new Map()}
      toggleRow={noop}
      visibleColumns={VISIBLE_COLUMNS}
    />
  );
  if (grouped) {
    return render(
      <DocumentsGridGroupsBody
        allSelected={false}
        groupCollapse={{ isCollapsed: () => false, setCollapsed: noop }}
        groups={[
          {
            key: "features",
            label: "Features",
            count: null,
            items: documentTreeRoots([nestedGroup()]),
          },
        ]}
        isNested
        leadingSortOptions={[]}
        onClearSort={noop}
        onRenderedItemsChange={noop}
        onSelectAll={noop}
        onSelectionChange={noop}
        onSort={noop}
        parentMap={new Map()}
        renderRowActions={() => null}
        rowExpansion={{ isExpanded: () => true, setExpanded: noop }}
        selectedIds={new Set()}
        selectMode={false}
        showCheckbox={false}
        someSelected={false}
        sortBy={null}
        sortDir="asc"
        visibleColumns={VISIBLE_COLUMNS}
      />
    );
  }
  return render(
    <div {...ariaTableProps(insideAriaTable, columnCount)}>
      <DocumentTableHeader
        insideAriaTable={insideAriaTable}
        onSort={noop}
        sortBy={null}
        sortDir="asc"
        visibleColumns={VISIBLE_COLUMNS}
      />
      {rows}
    </div>
  );
}

async function getAriaStructureViolations(container: Element) {
  const results = await axe.run(container, {
    resultTypes: ["violations"],
    runOnly: { type: "rule", values: ARIA_STRUCTURE_RULES },
  });
  return results.violations.map((violation) => ({
    id: violation.id,
    targets: violation.nodes.map((node) => node.target.join(" ")),
  }));
}

describe("Documents tree ARIA table semantics (ISS-4761)", () => {
  it("owns every row from the table and every cell from its row, nested rows included", () => {
    const { getByRole, getAllByRole } = renderTree();

    const table = getByRole("table");
    expect(table).toHaveAttribute("aria-colcount", String(COLUMN_COUNT));

    // Root + two nested children, plus the header row. A nested row that had
    // drifted under an intermediate container would still be found by role, so
    // ownership is asserted rather than presence.
    const rows = getAllByRole("row");
    expect(rows).toHaveLength(HEADER_ROW_COUNT + 3);

    for (const row of rows.slice(HEADER_ROW_COUNT)) {
      const cells = Array.from(row.querySelectorAll('[role="cell"]'));
      expect(cells).toHaveLength(COLUMN_COUNT);
      for (const cell of cells) {
        expect(cell.parentElement).toBe(row);
      }
    }
  });

  it("pairs each body cell with the column header in the same track", () => {
    const { getAllByRole } = renderTree();

    const headerCells = getAllByRole("columnheader");
    const bodyRow = getAllByRole("row")[HEADER_ROW_COUNT];
    const bodyCells = Array.from(bodyRow.querySelectorAll('[role="cell"]'));

    const indices = ["1", "2", "3", "4", "5"];
    expect(
      headerCells.map((cell) => cell.getAttribute("aria-colindex"))
    ).toEqual(indices);
    expect(bodyCells.map((cell) => cell.getAttribute("aria-colindex"))).toEqual(
      indices
    );

    // Locate headers by their column id, NOT by accessible name: FEA-4021's
    // reorder drag handle injects its own text into a sortable header's name
    // ("Reorder Type column, use arrow keys Type"), so a name-based lookup
    // would be asserting the handle's copy rather than the pairing.
    const cellByColumn = new Map(
      bodyCells.map((cell) => [
        cell.getAttribute("data-column-id"),
        cell.getAttribute("aria-colindex"),
      ])
    );
    expect(cellByColumn.get("name")).toBe("1");
    expect(cellByColumn.get(Col.Type)).toBe("2");
    expect(cellByColumn.get(Col.Updated)).toBe("4");
    expect(cellByColumn.get("actions")).toBe("5");
  });

  it("names the trailing More-menu column instead of exposing a blank header", () => {
    const { getAllByRole } = renderTree();

    // The track has no visible label, so without a name every row's action cell
    // would be announced under a blank column.
    const trailing = getAllByRole("columnheader").at(-1);
    expect(trailing).toHaveAttribute("aria-label", "Actions");
    expect(trailing).toHaveAttribute("aria-colindex", String(COLUMN_COUNT));
  });

  it("raises no ARIA structure violations, ungrouped or grouped", async () => {
    const ungrouped = renderTree();
    expect(await getAriaStructureViolations(ungrouped.container)).toEqual([]);
    ungrouped.unmount();

    // A group section is a rowgroup whose header is a row holding one cell that
    // spans every track — without it the section header's disclosure button
    // would be an orphan child of the table.
    const grouped = renderTree({ grouped: true });
    expect(await getAriaStructureViolations(grouped.container)).toEqual([]);
    const section = grouped.getAllByRole("rowgroup");
    expect(section).toHaveLength(1);
    const sectionHeaderCell = section[0].querySelector(
      `[role="${GRID_NAV_CELL_ROLE}"]`
    );
    expect(sectionHeaderCell).toHaveAttribute(
      "aria-colspan",
      String(COLUMN_COUNT)
    );
  });

  it("renders the prior role-less markup when the caller has not opted in", () => {
    const { queryByRole, container } = renderTree({ insideAriaTable: false });

    expect(queryByRole("table")).toBeNull();
    expect(container.querySelectorAll('[role="row"]')).toHaveLength(0);
    expect(container.querySelectorAll('[role="cell"]')).toHaveLength(0);
    expect(container.querySelectorAll("[aria-colindex]")).toHaveLength(0);
    // The rows themselves are unchanged — this is a semantics-only opt-in.
    expect(
      container.querySelectorAll("[data-column-id]").length
    ).toBeGreaterThan(0);
  });

  it("keeps a collapsed group's section header reachable as a disclosure", () => {
    const { getAllByRole } = renderTree({ grouped: true });

    const toggle = getAllByRole("button", { name: "Features" })[0];
    expect(toggle).toBeInTheDocument();
    fireEvent.click(toggle);
    // The button lives inside a table cell and stays operable; it is not
    // swallowed by the row/cell wrapper.
    expect(toggle.closest(`[role="${GRID_NAV_CELL_ROLE}"]`)).not.toBeNull();
  });

  it("prunes only the selected rows hidden by a Documents group collapse", () => {
    render(<DocumentsSelectionHarness />);
    expect(screen.getByTestId("selected-document-ids").textContent).toBe(
      "ISS-1,ISS-2"
    );

    fireEvent.click(screen.getByRole("button", { name: "Features" }));
    expect(screen.getByTestId("selected-document-ids").textContent).toBe(
      "ISS-2"
    );
    fireEvent.click(screen.getByRole("button", { name: "Features" }));
    expect(screen.getByTestId("selected-document-ids").textContent).toBe(
      "ISS-2"
    );
  });

  it("routes the header checkbox and Ctrl/Cmd+A to the same select-all handler", () => {
    const onSelectAll = vi.fn();
    render(
      <DocumentsGridGroupsBody
        allSelected={false}
        groupCollapse={{ isCollapsed: () => false, setCollapsed: noop }}
        groups={[
          {
            count: null,
            items: documentTreeRoots([nestedGroup()]).concat(
              makeRootItem("ISS-2")
            ),
            key: "features",
            label: "Features",
          },
        ]}
        isNested
        leadingSortOptions={[]}
        onClearSort={noop}
        onRenderedItemsChange={noop}
        onSelectAll={onSelectAll}
        onSelectionChange={noop}
        onSort={noop}
        parentMap={new Map()}
        renderRowActions={() => null}
        rowExpansion={{ isExpanded: () => false, setExpanded: noop }}
        selectedIds={new Set()}
        selectMode={false}
        showCheckbox
        someSelected={false}
        sortBy={null}
        sortDir="asc"
        visibleColumns={VISIBLE_COLUMNS}
      />
    );

    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(onSelectAll).toHaveBeenCalledExactlyOnceWith(true);

    onSelectAll.mockClear();
    const rootCell = document.querySelector<HTMLElement>(
      '[data-grid-row-id="ISS-1"] [data-grid-cell]'
    );
    if (!rootCell) {
      throw new Error("Expected the collapsed Documents root cell");
    }
    fireEvent.keyDown(rootCell, { ctrlKey: true, key: "a" });

    expect(onSelectAll).toHaveBeenCalledExactlyOnceWith(true);
  });
});
