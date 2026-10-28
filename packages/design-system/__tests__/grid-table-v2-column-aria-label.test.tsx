import {
  GridTableV2,
  type GridTableV2Column,
} from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { TableGridHeaderV2 } from "@closedloop-ai/design-system/components/ui/table-grid-header-v2";
import {
  ColumnFieldKind,
  createColumnRegistry,
} from "@closedloop-ai/design-system/lib/column-registry";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * The accessible name of a blank-label v2 column, end to end.
 *
 * `ColumnDefinition.ariaLabel` validated, `toGridColumns` carried it, and
 * `GridTableV2` then dropped it when it built the header's column array — so a
 * row-actions column passed the registry's `MissingAccessibleName` rule while
 * still rendering a `columnheader` that named nothing, and every body cell in
 * that track was announced under it. Its own controls were named by
 * interpolating the blank, giving " column options" and "Resize  column".
 *
 * Every assertion runs through `GridTableV2` rather than the header in
 * isolation, because the adapter is where the name was being lost.
 */

type Row = { id: string; name: string };

const ROWS: Row[] = [{ id: "r1", name: "Alpha" }];

const ACTIONS_COLUMN_ID = "actions";
const ACTIONS_NAME = "Row actions";
const RESIZE_HANDLE_NAME = new RegExp(`^Resize ${ACTIONS_NAME} column,`);
const RESIZE_OWNER_HANDLE_NAME = /^Resize Owner column,/;
const RESIZE_ITEM_HANDLE_NAME = /^Resize Item column,/;
const LEAD_SORT_OPTIONS = [
  { key: "name", label: "Name" },
  { key: "updated", label: "Updated" },
] as const;

function renderGrid(
  columns: readonly GridTableV2Column[],
  extra?: { resizable?: boolean }
) {
  return render(
    <GridTableV2<Row>
      columns={columns}
      columnWidths={extra?.resizable ? { [ACTIONS_COLUMN_ID]: 120 } : undefined}
      getRowId={(row) => row.id}
      gridTemplateColumns={`200px repeat(${columns.length}, 160px)`}
      headerActions={{}}
      items={ROWS}
      leadingLabel="Item"
      onColumnWidthChange={extra?.resizable ? vi.fn() : undefined}
      onSort={vi.fn()}
      renderCell={(columnId, row) => (columnId === "name" ? row.name : null)}
      renderLead={(row) => row.name}
      sortBy={null}
    />
  );
}

describe("GridTableV2 blank-label column accessible name", () => {
  it("names the columnheader from ariaLabel when the label is blank", () => {
    renderGrid([
      { id: "name", label: "Name" },
      { id: ACTIONS_COLUMN_ID, label: "", ariaLabel: ACTIONS_NAME },
    ]);
    expect(
      screen.getByRole("columnheader", { name: ACTIONS_NAME })
    ).toBeInTheDocument();
  });

  it("leaves a visible label as the header's own accessible name", () => {
    // A column the user can read must not have its visible text overridden — an
    // aria-label there announces something that is not on screen (WCAG 2.5.3).
    renderGrid([
      { id: "owner", label: "Owner", ariaLabel: "Something else entirely" },
    ]);
    expect(
      screen.getByRole("columnheader", { name: "Owner" })
    ).not.toHaveAttribute("aria-label");
  });

  it("names the column-options button from ariaLabel, not a blank label", () => {
    renderGrid([
      {
        id: ACTIONS_COLUMN_ID,
        label: "",
        ariaLabel: ACTIONS_NAME,
        sortable: true,
      },
    ]);
    expect(
      screen.getByRole("button", { name: `${ACTIONS_NAME} column options` })
    ).toBeInTheDocument();
    // The interpolated blank is the shape this replaces: an operable control
    // named " column options", unattributable to any column on the screen.
    expect(
      screen.queryByRole("button", { name: "column options" })
    ).not.toBeInTheDocument();
  });

  it("falls back to the column id when a blank-label column declares no ariaLabel", () => {
    // The registry refuses that combination, but `GridTableV2` is a public
    // component a host may call without one, so the control still needs a name
    // that tells it apart. Ugly and unique beats absent.
    renderGrid([{ id: ACTIONS_COLUMN_ID, label: "", sortable: true }]);
    expect(
      screen.getByRole("button", {
        name: `${ACTIONS_COLUMN_ID} column options`,
      })
    ).toBeInTheDocument();
  });

  it("names the columnheader from the column id when no ariaLabel is declared", () => {
    // The registry refuses a blank label with no `ariaLabel`, but `GridTableV2`
    // is public and a host may build the column by hand. An unnamed
    // `columnheader` is what every body cell in that track is announced
    // against, so the header takes the same id fallback its controls already
    // took, rather than being left with no name at all.
    renderGrid([{ id: ACTIONS_COLUMN_ID, label: "" }]);
    expect(
      screen.getByRole("columnheader", { name: ACTIONS_COLUMN_ID })
    ).toBeInTheDocument();
  });

  it("names the columnheader from the column id when ariaLabel is whitespace only", () => {
    renderGrid([{ id: ACTIONS_COLUMN_ID, label: "", ariaLabel: "   " }]);
    expect(
      screen.getByRole("columnheader", { name: ACTIONS_COLUMN_ID })
    ).toBeInTheDocument();
  });

  it("names the standalone sort button of a blank-label column", () => {
    // With no `actions` wired there is no options menu, so the column's only
    // control is this sort button — a caret and a blank label, and therefore no
    // accessible name at all before ISS-9706.
    render(
      <GridTableV2<Row>
        columns={[
          {
            id: ACTIONS_COLUMN_ID,
            label: "",
            ariaLabel: ACTIONS_NAME,
            sortable: true,
          },
        ]}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 160px"
        items={ROWS}
        leadingLabel="Item"
        onSort={vi.fn()}
        renderCell={() => null}
        renderLead={(row) => row.name}
        sortBy={null}
      />
    );
    expect(
      screen.getByRole("button", { name: ACTIONS_NAME })
    ).toBeInTheDocument();
  });

  it("leaves a visible label as the sort button's own accessible name", () => {
    // The mirror of the case above: overriding readable text with an aria-label
    // announces something that is not on screen (WCAG 2.5.3).
    render(
      <GridTableV2<Row>
        columns={[
          {
            id: "owner",
            label: "Owner",
            ariaLabel: "Something else",
            sortable: true,
          },
        ]}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 160px"
        items={ROWS}
        leadingLabel="Item"
        onSort={vi.fn()}
        renderCell={() => null}
        renderLead={(row) => row.name}
        sortBy={null}
      />
    );
    expect(screen.getByRole("button", { name: "Owner" })).not.toHaveAttribute(
      "aria-label"
    );
  });

  it("names the resize handle of a blank-label column", () => {
    renderGrid(
      [{ id: ACTIONS_COLUMN_ID, label: "", ariaLabel: ACTIONS_NAME }],
      {
        resizable: true,
      }
    );
    expect(
      screen.getByRole("button", { name: RESIZE_HANDLE_NAME })
    ).toBeInTheDocument();
  });

  it("treats a whitespace-only label as blank, exactly as the registry does", () => {
    // The registry's `MissingAccessibleName` rule trims before asking whether a
    // label exists, so `"   "` is a column that OWES an ariaLabel. If the header
    // decided blankness by truthiness instead — which is what v1 did before this
    // change — the validator would demand a name the header then discarded, and
    // the column would render nameless while validating clean.
    renderGrid([
      {
        id: ACTIONS_COLUMN_ID,
        label: "   ",
        ariaLabel: ACTIONS_NAME,
        sortable: true,
      },
    ]);
    expect(
      screen.getByRole("columnheader", { name: ACTIONS_NAME })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `${ACTIONS_NAME} column options` })
    ).toBeInTheDocument();
  });

  it("withholds aria-label from a header rendered outside an ARIA table", () => {
    // `aria-label` is prohibited on a role-less element, so the name may only
    // appear once the cell is a real `columnheader`. `TableGridHeaderV2` is
    // exported and defaults `insideAriaTable` off, so this arm is reachable by
    // any caller that does not go through `GridTableV2`.
    const { container } = render(
      <TableGridHeaderV2
        columns={[
          { id: ACTIONS_COLUMN_ID, label: "", ariaLabel: ACTIONS_NAME },
        ]}
        gridTemplateColumns="200px 160px"
        onSort={vi.fn()}
        sortBy={null}
        sortDir="asc"
      />
    );
    expect(screen.queryAllByRole("columnheader")).toHaveLength(0);
    const cell = container.querySelector(
      `[data-column-id="${ACTIONS_COLUMN_ID}"]`
    );
    expect(cell).not.toBeNull();
    expect(cell).not.toHaveAttribute("aria-label");
  });

  it("carries a validated registry's accessible name all the way to the element", () => {
    // The registry's own test proves `toGridColumns` emits `ariaLabel`; this is
    // the other half — that a set validating clean actually renders a named
    // header, which is the claim `column-registry.ts` now makes in its docstring.
    const registry = createColumnRegistry([
      {
        id: ACTIONS_COLUMN_ID,
        label: "",
        kind: ColumnFieldKind.Custom,
        ariaLabel: ACTIONS_NAME,
      },
    ]);
    renderGrid(registry.toGridColumns());
    expect(
      screen.getByRole("columnheader", { name: ACTIONS_NAME })
    ).toBeInTheDocument();
  });
});

/**
 * ISS-11837: a labelled header that renders the column-options button.
 *
 * A `columnheader` with no `aria-label` takes its name from its content. With
 * the options menu present, that content is the label, the
 * "<label> column options" button and, when the column resizes, the resize
 * handle. Chromium then announced "Owner Owner column options" for the header
 * and for every body cell in its track. The header is now named by its label
 * alone, and the button keeps its own name.
 *
 * jsdom's name computation already returns the bare label here, so a
 * name-only assertion passes with or without the fix. Each case therefore pins
 * the `aria-label` that makes the browser agree; the browser-computed name is
 * asserted by the documents index and Branches e2e specs.
 */
describe("GridTableV2 labelled column with an options menu (ISS-11837)", () => {
  it("names the columnheader by its label alone while the button keeps its name", () => {
    renderGrid([{ id: "owner", label: "Owner", sortable: true }]);
    expect(
      screen.getByRole("button", { name: "Owner column options" })
    ).toBeInTheDocument();
    const header = screen.getByRole("columnheader", { name: "Owner" });
    expect(header).toHaveAttribute("aria-label", "Owner");
    expect(header).toHaveAttribute("data-column-id", "owner");
  });

  it("names a resizable header by its label, not the resize handle's name", () => {
    renderGrid([{ id: ACTIONS_COLUMN_ID, label: "Owner", sortable: true }], {
      resizable: true,
    });
    expect(
      screen.getByRole("button", { name: RESIZE_OWNER_HANDLE_NAME })
    ).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Owner" })).toHaveAttribute(
      "aria-label",
      "Owner"
    );
  });

  it("uses the visible label, not a differing ariaLabel", () => {
    // WCAG 2.5.3: the visible label must be the accessible name, so a declared
    // `ariaLabel` on a labelled column does not replace it.
    renderGrid([
      {
        id: "owner",
        label: "Owner",
        ariaLabel: "Something else entirely",
        sortable: true,
      },
    ]);
    expect(screen.getByRole("columnheader", { name: "Owner" })).toHaveAttribute(
      "aria-label",
      "Owner"
    );
  });

  it("names the sortable lead columnheader by its label alone", () => {
    render(
      <GridTableV2<Row>
        columns={[{ id: "owner", label: "Owner", sortable: true }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 160px"
        headerActions={{}}
        items={ROWS}
        leadingLabel="Item"
        leadingSortKey="name"
        onSort={vi.fn()}
        renderCell={() => null}
        renderLead={(row) => row.name}
        sortBy={null}
      />
    );
    expect(
      screen.getByRole("button", { name: "Item column options" })
    ).toBeInTheDocument();
    const leadHeader = screen.getByRole("columnheader", { name: "Item" });
    expect(leadHeader).toHaveAttribute("aria-label", "Item");
    expect(leadHeader).toHaveAttribute("data-column-id", "__leading__");
  });

  it("withholds aria-label from the lead cell of a header rendered outside an ARIA table", () => {
    // `aria-label` is prohibited on a role-less element, so the lead cell's
    // name may only appear once it is a real `columnheader`, even when it
    // renders the options menu.
    const { container } = render(
      <TableGridHeaderV2
        actions={{}}
        columns={[]}
        gridTemplateColumns="200px"
        leadingLabel="Item"
        leadingSortKey="name"
        onSort={vi.fn()}
        sortBy={null}
        sortDir="asc"
      />
    );
    expect(
      screen.getByRole("button", { name: "Item column options" })
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("columnheader")).toHaveLength(0);
    const leadCell = container.querySelector('[data-column-id="__leading__"]');
    expect(leadCell).not.toBeNull();
    expect(leadCell).not.toHaveAttribute("aria-label");
  });

  it("withholds aria-label from a data cell with an options menu outside an ARIA table", () => {
    const { container } = render(
      <TableGridHeaderV2
        actions={{}}
        columns={[{ id: "owner", label: "Owner", sortable: true }]}
        gridTemplateColumns="200px 160px"
        onSort={vi.fn()}
        sortBy={null}
        sortDir="asc"
      />
    );
    expect(
      screen.getByRole("button", { name: "Owner column options" })
    ).toBeInTheDocument();
    const cell = container.querySelector('[data-column-id="owner"]');
    expect(cell).not.toBeNull();
    expect(cell).not.toHaveAttribute("aria-label");
  });
});

/**
 * ISS-11931: a header whose named control is the resize handle, the sort
 * button or the sort-options trigger, with no options menu.
 *
 * Chromium folds each control's `aria-label` into a content-derived header
 * name, so the server-driven Sessions lead column was announced as "Resize
 * Session column, N pixels wide, use arrow keys Session". The header is named by
 * its label alone, the rule ISS-11837 set for the options menu, and every
 * control keeps its own name.
 *
 * As above, jsdom computes the bare label either way, so each case pins the
 * `aria-label` attribute. The Sessions e2e specs on web and desktop assert the
 * browser-computed name.
 */
describe("GridTableV2 header with a named control and no options menu (ISS-11931)", () => {
  it("names a sort-button-only data header by its label alone", () => {
    render(
      <GridTableV2<Row>
        columns={[{ id: "owner", label: "Owner", sortable: true }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 160px"
        items={ROWS}
        leadingLabel="Item"
        onSort={vi.fn()}
        renderCell={() => null}
        renderLead={(row) => row.name}
        sortBy={null}
      />
    );
    expect(
      screen.queryByRole("button", { name: "Owner column options" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Owner" })).toHaveAttribute(
      "aria-label",
      "Owner"
    );
    expect(screen.getByRole("button", { name: "Owner" })).toBeInTheDocument();
  });

  it("names a resize-only data header by its label alone", () => {
    render(
      <GridTableV2<Row>
        columns={[{ id: "owner", label: "Owner" }]}
        columnWidths={{ owner: 160 }}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 160px"
        items={ROWS}
        leadingLabel="Item"
        onColumnWidthChange={vi.fn()}
        renderCell={() => null}
        renderLead={(row) => row.name}
      />
    );
    expect(
      screen.getByRole("button", { name: RESIZE_OWNER_HANDLE_NAME })
    ).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Owner" })).toHaveAttribute(
      "aria-label",
      "Owner"
    );
  });

  it("names a lead header with a plain sort button by its label alone", () => {
    render(
      <GridTableV2<Row>
        columns={[{ id: "owner", label: "Owner" }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 160px"
        items={ROWS}
        leadingLabel="Item"
        leadingSortKey="name"
        onSort={vi.fn()}
        renderCell={() => null}
        renderLead={(row) => row.name}
        sortBy={null}
      />
    );
    expect(screen.getByRole("button", { name: "Item" })).toBeInTheDocument();
    const leadHeader = screen.getByRole("columnheader", { name: "Item" });
    expect(leadHeader).toHaveAttribute("aria-label", "Item");
    expect(leadHeader).toHaveAttribute("data-column-id", "__leading__");
  });

  it("names a lead header with sort options and a resize handle by its label alone", () => {
    render(
      <GridTableV2<Row>
        columns={[{ id: "owner", label: "Owner" }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 160px"
        items={ROWS}
        leadingColumnWidth={200}
        leadingLabel="Item"
        leadingSortOptions={LEAD_SORT_OPTIONS}
        onLeadingColumnWidthChange={vi.fn()}
        onSort={vi.fn()}
        renderCell={() => null}
        renderLead={(row) => row.name}
        sortBy={null}
      />
    );
    expect(screen.getByRole("button", { name: "Item" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: RESIZE_ITEM_HANDLE_NAME })
    ).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Item" })).toHaveAttribute(
      "aria-label",
      "Item"
    );
  });

  it("keeps the ISS-9706 name on a blank-label resize-only header", () => {
    renderGrid(
      [{ id: ACTIONS_COLUMN_ID, label: "", ariaLabel: ACTIONS_NAME }],
      { resizable: true }
    );
    expect(
      screen.getByRole("button", { name: RESIZE_HANDLE_NAME })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: ACTIONS_NAME })
    ).toHaveAttribute("aria-label", ACTIONS_NAME);
  });

  it("leaves a lead header with no control unlabelled when its sort options are empty", () => {
    // `LeadingHeaderControl` renders the sort-options trigger only for a
    // non-empty list, so an empty one leaves just the static label, and the
    // header's own text is already its name.
    render(
      <GridTableV2<Row>
        columns={[{ id: "owner", label: "Owner" }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 160px"
        items={ROWS}
        leadingLabel="Item"
        leadingSortOptions={[]}
        onSort={vi.fn()}
        renderCell={() => null}
        renderLead={(row) => row.name}
        sortBy={null}
      />
    );
    expect(screen.queryByRole("button", { name: "Item" })).toBeNull();
    expect(
      screen.getByRole("columnheader", { name: "Item" })
    ).not.toHaveAttribute("aria-label");
  });

  it("withholds aria-label from resize-only data and lead cells outside an ARIA table", () => {
    const { container } = render(
      <TableGridHeaderV2
        columns={[{ id: "owner", label: "Owner" }]}
        gridTemplateColumns="200px 160px"
        leadingLabel="Item"
        leadingResize={{ onResize: vi.fn(), width: 200 }}
        onSort={vi.fn()}
        resize={{
          columnIds: ["owner"],
          getColumnWidth: () => 160,
          onResize: vi.fn(),
        }}
        sortBy={null}
        sortDir="asc"
      />
    );
    expect(
      screen.getByRole("button", { name: RESIZE_OWNER_HANDLE_NAME })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: RESIZE_ITEM_HANDLE_NAME })
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("columnheader")).toHaveLength(0);
    expect(
      container.querySelector('[data-column-id="owner"]')
    ).not.toHaveAttribute("aria-label");
    expect(
      container.querySelector('[data-column-id="__leading__"]')
    ).not.toHaveAttribute("aria-label");
  });
});
