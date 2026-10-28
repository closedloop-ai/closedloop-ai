import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { getNextSortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DocumentTableHeader } from "../table-header";

/**
 * FEA-4165 column reorder, on the v2 header (ISS-11412 Decision 6).
 *
 * `DocumentTableHeader` composes `TableGridHeaderV2` as designed. Where the
 * caller wires reorder (the documents index, the project page's document list
 * and My Tasks), each data column's header is the v2 options menu: "Sort
 * ascending", "Sort descending" and "Move column". That replaced the v1
 * arrow-key reorder handle and click-to-sort on those surfaces, an interaction
 * change approved by Daveth on 2026-10-01. The orders asserted below are the
 * ones the v1 handle emitted for the same moves.
 *
 * Where the caller wires no reorder (the Projects list, the skeleton) a sortable
 * header still sorts on click and renders no options menu.
 */

const VISIBLE_COLUMNS = [
  DocumentColumn.Type,
  DocumentColumn.Assignee,
  DocumentColumn.Priority,
];

const baseProps = {
  visibleColumns: VISIBLE_COLUMNS,
  sortBy: null,
  sortDir: "desc" as const,
  onSort: vi.fn(),
};

const OPTIONS_ANY = /column options$/;
const TYPE_OPTIONS = "Type column options";
const ASSIGNEE_OPTIONS = "Assignee column options";
const PRIORITY_OPTIONS = "Priority column options";
const MOVE_COLUMN = "Move column";

type User = ReturnType<typeof userEvent.setup>;

async function openOptions(user: User, name: string) {
  await user.click(screen.getByRole("button", { name }));
}

async function moveColumn(
  user: User,
  optionsName: string,
  direction: "Move left" | "Move right"
) {
  await openOptions(user, optionsName);
  await user.click(screen.getByRole("menuitem", { name: MOVE_COLUMN }));
  await user.click(await screen.findByRole("menuitem", { name: direction }));
}

describe("DocumentTableHeader — column reorder (FEA-4165)", () => {
  it("renders no column options menu when onReorderColumns is omitted", () => {
    render(<DocumentTableHeader {...baseProps} />);

    expect(
      screen.queryByRole("button", { name: OPTIONS_ANY })
    ).not.toBeInTheDocument();
  });

  it("renders an options menu per data column when reorder is wired", () => {
    render(<DocumentTableHeader {...baseProps} onReorderColumns={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: TYPE_OPTIONS })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: ASSIGNEE_OPTIONS })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: PRIORITY_OPTIONS })
    ).toBeInTheDocument();
  });

  it("emits the reordered VISIBLE order when a column is moved right from its menu", async () => {
    const user = userEvent.setup();
    const onReorderColumns = vi.fn();
    render(
      <DocumentTableHeader {...baseProps} onReorderColumns={onReorderColumns} />
    );

    await moveColumn(user, TYPE_OPTIONS, "Move right");

    expect(onReorderColumns).toHaveBeenCalledWith([
      DocumentColumn.Assignee,
      DocumentColumn.Type,
      DocumentColumn.Priority,
    ]);
  });

  it("does not move a column past the left edge", async () => {
    const user = userEvent.setup();
    const onReorderColumns = vi.fn();
    render(
      <DocumentTableHeader {...baseProps} onReorderColumns={onReorderColumns} />
    );

    // Type is already first. v1 emitted the unchanged order here; the v2 menu
    // emits nothing at the edge. Either way the visible order is unchanged.
    await moveColumn(user, TYPE_OPTIONS, "Move left");

    expect(onReorderColumns).not.toHaveBeenCalled();
  });

  it("sorts a column ascending and descending from its menu", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    render(
      <DocumentTableHeader
        {...baseProps}
        onReorderColumns={vi.fn()}
        onSort={onSort}
      />
    );

    await openOptions(user, PRIORITY_OPTIONS);
    await user.click(screen.getByRole("menuitem", { name: "Sort ascending" }));
    await openOptions(user, PRIORITY_OPTIONS);
    await user.click(screen.getByRole("menuitem", { name: "Sort descending" }));

    expect(onSort.mock.calls).toEqual([
      [DocumentColumn.Priority, "asc"],
      [DocumentColumn.Priority, "desc"],
    ]);
  });

  it("keeps click-to-sort when reorder is not wired (Projects list, skeleton)", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    render(
      <DocumentTableHeader
        {...baseProps}
        onSort={onSort}
        sortBy={DocumentColumn.Priority}
        sortDir="desc"
      />
    );

    await user.click(screen.getByRole("button", { name: "Assignee" }));
    await user.click(screen.getByRole("button", { name: "Priority" }));

    expect(onSort.mock.calls).toEqual([
      [DocumentColumn.Assignee, getNextSortDirection(false, "desc")],
      [DocumentColumn.Priority, getNextSortDirection(true, "desc")],
    ]);
    expect(
      screen.queryByRole("button", { name: OPTIONS_ANY })
    ).not.toBeInTheDocument();
  });
});
