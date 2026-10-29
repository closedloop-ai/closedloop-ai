import {
  type Column,
  DataTable,
} from "@closedloop-ai/design-system/components/ui/data-table";
import { COLLAPSE_EMPTY } from "@closedloop-ai/design-system/lib/collapse-columns";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const CONSTANT_PATTERN = /Constant/;
const NAME_PATTERN = /Name/;
const COUNT_PATTERN = /Count/;

/**
 * ISS-7349. `DataTable` is a table primitive: it owns search,
 * sort, filter, pagination, opt-in column collapse, and row navigation, all as
 * internal state. The story sweep mounts it with one dataset and reads the
 * default page, so what it never reaches is every state the user creates —
 * a search that matches nothing, a filter that empties the page, a sort
 * reversed by clicking the same header twice, a page-size change that must
 * reset the page.
 *
 * The two contracts worth naming: the empty state must survive a search or
 * filter that eliminates every row (an empty table body that renders nothing at
 * all reads as broken), and the ACTIVE SORT COLUMN is never collapsed —
 * dropping the header that reverses the sort would strand the user with no way
 * back.
 */

type Row = {
  id: string;
  name: string;
  status: string;
  count: number;
  seen: Date;
  constant: string;
  blank: string;
};

function row(overrides: Partial<Row> & { id: string }): Row {
  return {
    blank: "",
    constant: "same",
    count: 0,
    name: "row",
    seen: new Date("2026-08-01T00:00:00.000Z"),
    status: "open",
    ...overrides,
  };
}

const ROWS: Row[] = [
  row({
    count: 3,
    id: "1",
    name: "Alpha",
    seen: new Date("2026-08-03"),
    status: "open",
  }),
  row({
    count: 1,
    id: "2",
    name: "Beta",
    seen: new Date("2026-08-01"),
    status: "done",
  }),
  row({
    count: 2,
    id: "3",
    name: "Gamma",
    seen: new Date("2026-08-02"),
    status: "open",
  }),
];

const COLUMNS: Column<Row>[] = [
  { header: "Name", key: "name", sortable: true },
  { header: "Status", key: "status" },
  { header: "Count", key: "count", sortable: true },
];

/** Body row order, by the first cell's text. */
function renderedNames(): string[] {
  const [, ...bodyRows] = screen.getAllByRole("row");
  return bodyRows.map(
    (bodyRow) => within(bodyRow).getAllByRole("cell")[0].textContent ?? ""
  );
}

/**
 * Open one of the toolbar's Radix selects and commit a choice. A plain click on
 * the trigger does not open a Radix select — it listens on pointerdown — so a
 * test that "changes the filter" by clicking asserts against a menu that never
 * opened and passes on the untouched initial value.
 */
function chooseOption(triggerLabel: string, optionName: string): void {
  const trigger = screen.getByLabelText(triggerLabel);
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

describe("DataTable rendering", () => {
  it("renders one body row per item with the column values", () => {
    render(<DataTable columns={COLUMNS} data={ROWS} />);

    expect(renderedNames()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("renders a column's custom renderer instead of the raw value", () => {
    render(
      <DataTable
        columns={[
          {
            header: "Name",
            key: "name",
            render: (item) => <b>{item.name}!</b>,
          },
        ]}
        data={ROWS}
      />
    );

    expect(screen.getByText("Alpha!")).toBeInTheDocument();
  });

  it("renders an empty string for a missing value rather than 'undefined'", () => {
    render(
      <DataTable columns={[{ header: "Ghost", key: "ghost" }]} data={ROWS} />
    );

    const [, firstRow] = screen.getAllByRole("row");
    expect(within(firstRow).getAllByRole("cell")[0]).toHaveTextContent("");
  });

  it("shows the default empty message for no data", () => {
    render(<DataTable columns={COLUMNS} data={[]} />);

    expect(screen.getByText("No items found.")).toBeInTheDocument();
  });

  it("shows a caller-supplied empty message", () => {
    render(
      <DataTable columns={COLUMNS} data={[]} emptyMessage="Nothing here yet" />
    );

    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
  });

  it("reports the total item count with a singular noun for one row", () => {
    render(<DataTable columns={COLUMNS} data={[ROWS[0]]} />);

    expect(screen.getByText("1 item total")).toBeInTheDocument();
  });

  it("reports the total item count with a plural noun otherwise", () => {
    render(<DataTable columns={COLUMNS} data={ROWS} />);

    expect(screen.getByText("3 items total")).toBeInTheDocument();
  });
});

describe("DataTable search", () => {
  it("renders no search box when the caller declares no search key", () => {
    render(<DataTable columns={COLUMNS} data={ROWS} />);

    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("narrows the rows case-insensitively on the search key", () => {
    render(<DataTable columns={COLUMNS} data={ROWS} searchKey="name" />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "bet" },
    });

    expect(renderedNames()).toEqual(["Beta"]);
  });

  it("falls to the empty state when the search matches nothing", () => {
    // The state a user actually creates, and the one a story never renders.
    render(<DataTable columns={COLUMNS} data={ROWS} searchKey="name" />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "zzz" },
    });

    expect(screen.getByText("No items found.")).toBeInTheDocument();
    expect(screen.getByText("0 items total")).toBeInTheDocument();
  });

  it("matches nothing when the search key holds a non-string value", () => {
    // The filter returns false for a non-string cell rather than coercing, so a
    // numeric column cannot be searched at all. Pins current behavior; it looks
    // odd because the search box is offered regardless of the key's type.
    render(<DataTable columns={COLUMNS} data={ROWS} searchKey="count" />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "3" } });

    expect(screen.getByText("No items found.")).toBeInTheDocument();
  });

  it("names the search box with the supplied placeholder", () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        searchKey="name"
        searchPlaceholder="Find a row"
      />
    );

    expect(screen.getByLabelText("Find a row")).toBeInTheDocument();
  });
});

describe("DataTable column sorting", () => {
  it("sorts ascending on the first header click", () => {
    render(<DataTable columns={COLUMNS} data={ROWS} />);

    fireEvent.click(screen.getByRole("button", { name: COUNT_PATTERN }));

    expect(renderedNames()).toEqual(["Beta", "Gamma", "Alpha"]);
  });

  it("reverses to descending on a second click of the same header", () => {
    render(<DataTable columns={COLUMNS} data={ROWS} />);
    const countHeader = screen.getByRole("button", { name: COUNT_PATTERN });

    fireEvent.click(countHeader);
    fireEvent.click(countHeader);

    expect(renderedNames()).toEqual(["Alpha", "Gamma", "Beta"]);
  });

  it("restarts at ascending when a different header is clicked", () => {
    render(<DataTable columns={COLUMNS} data={ROWS} />);

    fireEvent.click(screen.getByRole("button", { name: COUNT_PATTERN }));
    fireEvent.click(screen.getByRole("button", { name: COUNT_PATTERN }));
    fireEvent.click(screen.getByRole("button", { name: NAME_PATTERN }));

    expect(renderedNames()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("sorts strings with locale comparison in both directions", () => {
    render(<DataTable columns={COLUMNS} data={ROWS} />);
    const nameHeader = screen.getByRole("button", { name: NAME_PATTERN });

    fireEvent.click(nameHeader);
    expect(renderedNames()).toEqual(["Alpha", "Beta", "Gamma"]);

    fireEvent.click(nameHeader);
    expect(renderedNames()).toEqual(["Gamma", "Beta", "Alpha"]);
  });

  it("sorts dates chronologically through the sort dropdown", () => {
    render(
      <DataTable
        columns={[{ header: "Name", key: "name" }]}
        data={ROWS}
        sortOptions={[
          { label: "Oldest", value: "seen:asc" },
          { label: "Newest", value: "seen:desc" },
        ]}
      />
    );

    // The first sortOption is the initial state, so this renders the asc branch.
    expect(renderedNames()).toEqual(["Beta", "Gamma", "Alpha"]);

    // Then DRIVE the dropdown. Asserting only the initial order left the desc
    // branch — and `onValueChange` itself — deletable with this test green.
    chooseOption("Sort", "Newest");

    expect(renderedNames()).toEqual(["Alpha", "Gamma", "Beta"]);
  });

  it("leaves rows in place when the sorted values are not comparable", () => {
    // Mixed/unsupported types fall to the `return 0` arm — a stable no-op sort
    // rather than an arbitrary reorder.
    render(
      <DataTable
        columns={[
          { header: "Seen", key: "seen" },
          { header: "Name", key: "name" },
        ]}
        data={ROWS}
        sortOptions={[{ label: "By blank", value: "missing:asc" }]}
      />
    );

    const [, ...bodyRows] = screen.getAllByRole("row");
    expect(
      bodyRows.map((r) => within(r).getAllByRole("cell")[1].textContent)
    ).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("hides the sort dropdown when any column header is sortable", () => {
    // Both drive the same sort state; showing them together would let one
    // silently override the other.
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        sortOptions={[{ label: "Name", value: "name:asc" }]}
      />
    );

    expect(screen.queryByLabelText("Sort")).toBeNull();
  });

  it("shows the sort dropdown when no column header is sortable", () => {
    render(
      <DataTable
        columns={[{ header: "Name", key: "name" }]}
        data={ROWS}
        sortOptions={[{ label: "Name", value: "name:asc" }]}
      />
    );

    expect(screen.getByLabelText("Sort")).toBeInTheDocument();
  });
});

describe("DataTable filtering", () => {
  it("renders no filter control without filter options", () => {
    render(<DataTable columns={COLUMNS} data={ROWS} filterKey="status" />);

    expect(screen.queryByLabelText("Filter")).toBeNull();
  });

  it("renders the filter control when options are supplied", () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        filterKey="status"
        filterOptions={[{ label: "Open", value: "open" }]}
      />
    );

    expect(screen.getByLabelText("Filter")).toBeInTheDocument();
  });

  it("shows every row while the filter is on 'all'", () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        filterKey="status"
        filterOptions={[{ label: "Open", value: "open" }]}
      />
    );

    expect(renderedNames()).toHaveLength(3);
  });

  it("narrows to the matching rows once a facet is chosen", () => {
    // The `filter !== "all"` arm. Leaving every case on the initial value let
    // the whole filtering branch be deleted with this describe block green.
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        filterKey="status"
        filterOptions={[
          { label: "Open", value: "open" },
          { label: "Done", value: "done" },
        ]}
      />
    );

    chooseOption("Filter", "Done");

    expect(renderedNames()).toEqual(["Beta"]);
  });

  it("shows the empty state when the chosen facet matches no row", () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        filterKey="status"
        filterOptions={[
          { label: "Open", value: "open" },
          { label: "Archived", value: "archived" },
        ]}
      />
    );

    chooseOption("Filter", "Archived");

    expect(screen.getByText("No items found.")).toBeVisible();
  });
});

describe("DataTable pagination", () => {
  const MANY: Row[] = Array.from({ length: 25 }, (_unused, index) =>
    row({ id: String(index), name: `Row ${index}` })
  );

  it("renders no pager when everything fits on one page", () => {
    render(<DataTable columns={COLUMNS} data={ROWS} />);

    expect(screen.queryByLabelText("Go to next page")).toBeNull();
  });

  it("shows only the first page and the page indicator", () => {
    render(<DataTable columns={COLUMNS} data={MANY} pageSize={10} />);

    expect(renderedNames()).toHaveLength(10);
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
  });

  it("disables the previous control on the first page", () => {
    render(<DataTable columns={COLUMNS} data={MANY} pageSize={10} />);

    expect(screen.getByLabelText("Go to previous page")).toBeDisabled();
  });

  it("advances to the next page", () => {
    render(<DataTable columns={COLUMNS} data={MANY} pageSize={10} />);

    fireEvent.click(screen.getByLabelText("Go to next page"));

    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    expect(renderedNames()[0]).toBe("Row 10");
  });

  it("renders the short final page and disables the next control there", () => {
    render(<DataTable columns={COLUMNS} data={MANY} pageSize={10} />);

    fireEvent.click(screen.getByLabelText("Go to next page"));
    fireEvent.click(screen.getByLabelText("Go to next page"));

    expect(renderedNames()).toHaveLength(5);
    expect(screen.getByLabelText("Go to next page")).toBeDisabled();
  });

  it("goes back a page", () => {
    render(<DataTable columns={COLUMNS} data={MANY} pageSize={10} />);

    fireEvent.click(screen.getByLabelText("Go to next page"));
    fireEvent.click(screen.getByLabelText("Go to previous page"));

    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
  });

  it("returns to the first page when a search narrows the results", () => {
    // Without the reset a user lands on a page that no longer exists and sees
    // an empty table with rows they know are there.
    render(
      <DataTable columns={COLUMNS} data={MANY} pageSize={10} searchKey="name" />
    );

    fireEvent.click(screen.getByLabelText("Go to next page"));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Row 1" },
    });

    expect(renderedNames()[0]).toBe("Row 1");
  });

  it("renders no page-size control without options", () => {
    render(<DataTable columns={COLUMNS} data={MANY} pageSize={10} />);

    expect(screen.queryByLabelText("Rows per page")).toBeNull();
  });

  it("renders the page-size control when options are supplied", () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={MANY}
        pageSize={10}
        pageSizeOptions={[10, 25]}
      />
    );

    expect(screen.getByLabelText("Rows per page")).toBeInTheDocument();
  });

  it("defers the page size to the parent when it supplies a change handler", () => {
    // The controlled path: internal state is bypassed entirely, so a parent that
    // ignores the callback keeps the size it passed.
    const onPageSizeChange = vi.fn();
    const { rerender } = render(
      <DataTable
        columns={COLUMNS}
        data={MANY}
        onPageSizeChange={onPageSizeChange}
        pageSize={5}
        pageSizeOptions={[5, 10]}
      />
    );

    expect(renderedNames()).toHaveLength(5);

    chooseOption("Rows per page", "10");

    // The callback fires AND the rendered size does not move on its own. Only
    // asserting the initial render passed against an implementation that
    // updates internal state and ignores the parent entirely.
    expect(onPageSizeChange).toHaveBeenCalledWith(10);
    expect(renderedNames()).toHaveLength(5);

    rerender(
      <DataTable
        columns={COLUMNS}
        data={MANY}
        onPageSizeChange={onPageSizeChange}
        pageSize={10}
        pageSizeOptions={[5, 10]}
      />
    );

    expect(renderedNames()).toHaveLength(10);
  });
});

describe("DataTable row interaction", () => {
  it("calls onRowClick with the clicked item", () => {
    const onRowClick = vi.fn();
    render(<DataTable columns={COLUMNS} data={ROWS} onRowClick={onRowClick} />);

    const [, firstRow] = screen.getAllByRole("row");
    fireEvent.click(firstRow);

    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });

  it("renders a row-covering link when rowHref is supplied", () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        rowHref={(item) => `/rows/${item.id}`}
      />
    );

    expect(screen.getAllByRole("link", { name: "Open" })[0]).toHaveAttribute(
      "href",
      "/rows/1"
    );
  });

  it("omits the link for a row whose href resolves to undefined", () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        rowHref={(item) => (item.id === "1" ? "/rows/1" : undefined)}
      />
    );

    expect(screen.getAllByRole("link", { name: "Open" })).toHaveLength(1);
  });

  it("does not fire the row handler when the row also carries an href", () => {
    // The href owns navigation; the row handler is wired only on the anchor so a
    // plain click is not double-handled.
    const onRowClick = vi.fn();
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        onRowClick={onRowClick}
        rowHref={(item) => `/rows/${item.id}`}
      />
    );

    const [, firstRow] = screen.getAllByRole("row");
    fireEvent.click(firstRow);

    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("intercepts a plain left click on the row link", () => {
    const onRowClick = vi.fn();
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        onRowClick={onRowClick}
        rowHref={(item) => `/rows/${item.id}`}
      />
    );

    fireEvent.click(screen.getAllByRole("link", { name: "Open" })[0], {
      button: 0,
    });

    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });

  it("lets a modified click through so open-in-new-tab still works", () => {
    const onRowClick = vi.fn();
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        onRowClick={onRowClick}
        rowHref={(item) => `/rows/${item.id}`}
      />
    );

    fireEvent.click(screen.getAllByRole("link", { name: "Open" })[0], {
      button: 0,
      metaKey: true,
    });

    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("renders a row-actions cell and does not bubble its clicks to the row", () => {
    const onRowClick = vi.fn();
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        onRowClick={onRowClick}
        renderRowActions={(item) => (
          <button type="button">Act {item.id}</button>
        )}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Act 1" }));

    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe("DataTable column collapse", () => {
  const getKey = (columnId: string, item: Row) => {
    if (columnId === "constant") {
      return item.constant;
    }
    if (columnId === "blank") {
      return item.blank === "" ? COLLAPSE_EMPTY : item.blank;
    }
    return String(item[columnId as keyof Row] ?? "");
  };

  const COLLAPSIBLE: Column<Row>[] = [
    { header: "Name", key: "name", sortable: true },
    { header: "Constant", key: "constant" },
    { header: "Blank", key: "blank" },
  ];

  it("keeps every column when the caller does not opt in", () => {
    render(<DataTable columns={COLLAPSIBLE} data={ROWS} />);

    expect(screen.getByText("Constant")).toBeInTheDocument();
    expect(screen.getByText("Blank")).toBeInTheDocument();
  });

  it("drops constant and empty columns when the caller opts in", () => {
    render(
      <DataTable collapse={{ getKey }} columns={COLLAPSIBLE} data={ROWS} />
    );

    expect(screen.queryByText("Constant")).toBeNull();
    expect(screen.queryByText("Blank")).toBeNull();
    expect(
      screen.getByRole("button", { name: NAME_PATTERN })
    ).toBeInTheDocument();
  });

  it("keeps an empty column when the empty rule is switched off", () => {
    render(
      <DataTable
        collapse={{ getKey, options: { collapseEmptyColumns: false } }}
        columns={COLLAPSIBLE}
        data={ROWS}
      />
    );

    expect(screen.getByText("Blank")).toBeInTheDocument();
    expect(screen.queryByText("Constant")).toBeNull();
  });

  it("never collapses the ACTIVE SORT column", () => {
    // Dropping the header that reverses the sort would strand the user with no
    // way back to the other direction. `sortOptions[0]` seeds the sort state
    // even when the dropdown itself is hidden by a sortable column header, so
    // this mounts with "constant" already active.
    render(
      <DataTable
        collapse={{ getKey }}
        columns={[
          { header: "Name", key: "name", sortable: true },
          { header: "Constant", key: "constant", sortable: true },
        ]}
        data={ROWS}
        sortOptions={[{ label: "Constant", value: "constant:asc" }]}
      />
    );

    expect(
      screen.getByRole("button", { name: CONSTANT_PATTERN })
    ).toBeInTheDocument();
  });

  it("collapses a sortable column that is not yet the active sort", () => {
    // Pins current behavior; it looks odd because the active-sort guard cannot
    // protect a column that collapsed BEFORE it was ever sorted — there is no
    // header left to click, so a constant-valued sortable column can never
    // become the active sort in the first place. Only a sort already active at
    // mount reaches the guard.
    render(
      <DataTable
        collapse={{ getKey }}
        columns={[
          { header: "Name", key: "name" },
          { header: "Constant", key: "constant", sortable: true },
        ]}
        data={ROWS}
      />
    );

    expect(screen.queryByRole("button", { name: CONSTANT_PATTERN })).toBeNull();
  });

  it("decides collapse from the VISIBLE page, not the whole dataset", () => {
    // Page 2 is uniform on "status" even though the dataset is not, so the
    // column collapses there — paging must not be decided by rows the user
    // cannot see.
    const paged: Row[] = [
      ...Array.from({ length: 2 }, (_unused, index) =>
        row({ id: `a${index}`, name: `A${index}`, status: "open" })
      ),
      ...Array.from({ length: 2 }, (_unused, index) =>
        row({ id: `b${index}`, name: `B${index}`, status: "done" })
      ),
    ];

    render(
      <DataTable
        collapse={{ getKey, options: { collapseEmptyColumns: false } }}
        columns={[
          { header: "Name", key: "name" },
          { header: "Status", key: "status" },
        ]}
        data={paged}
        pageSize={2}
      />
    );

    expect(screen.queryByText("Status")).toBeNull();
  });
});
