import {
  TableGridHeaderV2,
  type TableGridHeaderV2Actions,
  type TableGridHeaderV2Column,
} from "@closedloop-ai/design-system/components/ui/table-grid-header-v2";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * ISS-11837: the v2 header label's cursor and the column menu's separator, on
 * a header whose columns are wired for reorder.
 *
 * Reorder is what gives every ordered column the options menu (with "Move
 * column") and the "Drag to reorder column" tooltip, so each case renders the
 * header the way the documents index, My Tasks, Sessions and Branches do.
 */

const COLUMN_ID = "tags";
const COLUMN_LABEL = "Tags";
const OPTIONS_NAME = `${COLUMN_LABEL} column options`;

const noop = () => {
  // onSort is required; these cases never sort.
};

function renderReorderableHeader(
  column: Partial<TableGridHeaderV2Column>,
  actions?: TableGridHeaderV2Actions
) {
  return render(
    <TableGridHeaderV2
      actions={actions}
      columns={[{ id: COLUMN_ID, label: COLUMN_LABEL, ...column }]}
      gridTemplateColumns="200px 160px"
      onSort={noop}
      reorder={{ columnOrder: [COLUMN_ID], onReorder: vi.fn() }}
      sortBy={null}
      sortDir="asc"
    />
  );
}

async function openColumnMenu(): Promise<HTMLElement> {
  fireEvent.pointerDown(screen.getByRole("button", { name: OPTIONS_NAME }), {
    button: 0,
    ctrlKey: false,
  });
  return await screen.findByRole("menu");
}

describe("TableGridHeaderV2 column menu separator (ISS-11837)", () => {
  it("renders no separator when Move column is the only item", async () => {
    renderReorderableHeader({ sortable: false });

    const menu = await openColumnMenu();

    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent)
    ).toEqual(["Move column"]);
    expect(within(menu).queryByRole("separator")).toBeNull();
  });

  it("renders the separator when the Sort items precede Move column", async () => {
    renderReorderableHeader({ sortable: true });

    const menu = await openColumnMenu();

    expect(within(menu).getByRole("separator")).toBeInTheDocument();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent)
    ).toEqual(["Sort ascending", "Sort descending", "Move column"]);
  });

  it("renders the separator when a Filter item precedes Move column", async () => {
    renderReorderableHeader(
      { filterable: true, sortable: false },
      { onFilter: vi.fn() }
    );

    const menu = await openColumnMenu();

    expect(within(menu).getByRole("separator")).toBeInTheDocument();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent)
    ).toEqual(["Filter", "Move column"]);
  });

  it("renders no separator when the filter callback supplies no content", async () => {
    // `filterable` is a capability and `getFilterContent` may return nothing for
    // a column, in which case no Filter item renders and nothing precedes Move
    // column.
    renderReorderableHeader(
      { filterable: true, sortable: false },
      { getFilterContent: () => null }
    );

    const menu = await openColumnMenu();

    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent)
    ).toEqual(["Move column"]);
    expect(within(menu).queryByRole("separator")).toBeNull();
  });

  it("renders the separator when a Group item precedes Move column", async () => {
    renderReorderableHeader(
      { groupable: true, sortable: false },
      { onGroup: vi.fn() }
    );

    const menu = await openColumnMenu();

    expect(within(menu).getByRole("separator")).toBeInTheDocument();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent)
    ).toEqual(["Group", "Move column"]);
  });

  it("renders no separator when Group is a capability the host did not wire", async () => {
    // `groupable` without `actions.onGroup` renders no Group item, so nothing
    // precedes Move column.
    renderReorderableHeader({ groupable: true, sortable: false }, {});

    const menu = await openColumnMenu();

    expect(within(menu).queryByRole("separator")).toBeNull();
  });
});

describe("TableGridHeaderV2 draggable label cursor (ISS-11837)", () => {
  it("shows the grab cursor, not the pointer, on a reorder-only label", () => {
    // Reorder supplies the "Drag to reorder column" tooltip. A click on the
    // label does nothing, so the pointer cursor promised an action that is not
    // there; the grab cursor is the drag the label really offers.
    renderReorderableHeader({ sortable: false });

    const label = screen.getByText(COLUMN_LABEL);

    expect(label).toHaveAttribute("data-slot", "tooltip-trigger");
    expect(label).toHaveClass("cursor-grab", "active:cursor-grabbing");
    expect(label).not.toHaveClass("cursor-pointer");
  });

  it("keeps the grab cursor when the column declares its own tooltip", () => {
    renderReorderableHeader({ sortable: true, tooltip: "Help text" });

    const label = screen.getByText(COLUMN_LABEL);

    expect(label).toHaveClass("cursor-grab");
    expect(label).not.toHaveClass("cursor-pointer");
  });

  it("keeps the pointer cursor on a tooltip label that cannot be dragged", () => {
    render(
      <TableGridHeaderV2
        actions={{}}
        columns={[
          {
            id: COLUMN_ID,
            label: COLUMN_LABEL,
            sortable: true,
            tooltip: "Help text",
          },
        ]}
        gridTemplateColumns="200px 160px"
        onSort={noop}
        sortBy={null}
        sortDir="asc"
      />
    );

    const label = screen.getByText(COLUMN_LABEL);

    expect(label).toHaveClass("cursor-pointer");
    expect(label).not.toHaveClass("cursor-grab");
  });
});

/**
 * ISS-11931 names the lead header by its label when it renders the options
 * menu; this guards that the menu itself keeps today's Sort items.
 */
describe("TableGridHeaderV2 lead column menu (ISS-11931)", () => {
  it("keeps the Sort items in the lead column's menu", async () => {
    render(
      <TableGridHeaderV2
        actions={{}}
        columns={[]}
        gridTemplateColumns="200px"
        insideAriaTable
        leadingLabel="Item"
        leadingSortKey="name"
        onSort={noop}
        sortBy={null}
        sortDir="asc"
      />
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Item column options" }),
      { button: 0, ctrlKey: false }
    );
    const menu = await screen.findByRole("menu");

    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent)
    ).toEqual(["Sort ascending", "Sort descending"]);
  });
});
