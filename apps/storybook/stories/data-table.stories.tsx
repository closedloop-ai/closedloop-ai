import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  type Column,
  DataTable,
  type FilterOption,
  type SortOption,
} from "@repo/design-system/components/ui/data-table";
import {
  type MockProjectRow,
  mockProjectRows,
} from "@repo/design-system/storybook/mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { action } from "storybook/actions";
import { expect, screen, userEvent, within } from "storybook/test";

// The accessible names DataTable gives its own controls. Its pager is icon-only
// and its selects are named by an adjacent span that is not wired up as a
// label, so without these the controls are unreachable by name.
//
// The pager strings match the design-system pagination primitive rather than
// reading more naturally on their own: every other pager in the product
// announces "Go to next page" through `PaginationNext`, and DataTable was the
// only site saying something else.
const NEXT_PAGE_LABEL = "Go to next page";
const PREVIOUS_PAGE_LABEL = "Go to previous page";
const PAGE_SIZE_LABEL = "Rows per page";

const columns: Column<MockProjectRow>[] = [
  {
    key: "name",
    header: "Project",
    sortable: true,
  },
  {
    key: "owner",
    header: "Owner",
    sortable: true,
  },
  {
    key: "status",
    header: "Status",
    sortable: true,
    render: (item) => <Badge variant="outline">{item.status}</Badge>,
  },
  {
    key: "updatedAt",
    header: "Updated",
    sortable: true,
  },
];

type ProjectDataTableProps = {
  data: MockProjectRow[];
  columns: Column<MockProjectRow>[];
  searchPlaceholder?: string;
  searchKey?: keyof MockProjectRow;
  sortOptions?: SortOption[];
  filterOptions?: FilterOption[];
  filterKey?: keyof MockProjectRow;
  onRowClick?: (item: MockProjectRow) => void;
  rowHref?: (item: MockProjectRow) => string | undefined;
  renderRowActions?: (item: MockProjectRow) => ReactNode;
  pageSize?: number;
  pageSizeOptions?: number[];
  onPageSizeChange?: (pageSize: number) => void;
  emptyMessage?: string;
};

const ProjectDataTable = (props: ProjectDataTableProps) => (
  <DataTable<MockProjectRow> {...props} />
);

/**
 * A full table with search, filtering, sorting and pagination built in, used
 * instead of Table for those controls, or Grid Table when you don't need
 * resizable columns.
 */
const meta = {
  title: "Primitives/Data Display/Data Table",
  component: ProjectDataTable,
  tags: ["autodocs"],
  argTypes: {
    data: { control: "object", table: { category: "Data" } },
    // Column definitions carry `render` functions, so a JSON editor here would
    // hand the table a plain object where a function is expected.
    columns: { control: false, table: { category: "Data" } },
    searchKey: {
      options: ["id", "name", "owner", "status", "updatedAt"],
      control: { type: "select" },
      description: "Row field the search box matches against.",
      table: { category: "Data" },
    },
    filterKey: {
      options: ["id", "name", "owner", "status", "updatedAt"],
      control: { type: "select" },
      description: "Row field the filter select matches against.",
      table: { category: "Data" },
    },
    sortOptions: {
      control: "object",
      description:
        "Sort dropdown entries as `field:asc` or `field:desc`. Ignored when any column is sortable.",
      table: { category: "Data" },
    },
    filterOptions: { control: "object", table: { category: "Data" } },
    searchPlaceholder: { control: "text", table: { category: "Content" } },
    emptyMessage: { control: "text", table: { category: "Content" } },
    pageSize: {
      control: { type: "number", min: 1, max: 50, step: 1 },
      table: { category: "Pagination" },
    },
    pageSizeOptions: { control: "object", table: { category: "Pagination" } },
    rowHref: {
      control: false,
      description: "Turns each row into a link when it returns a href.",
      table: { category: "Rendering" },
    },
    renderRowActions: { control: false, table: { category: "Rendering" } },
    onRowClick: { control: false, table: { category: "Events" } },
    // Deliberately left without an arg: supplying `onPageSizeChange` switches
    // the table to a controlled page size, which would freeze the pager the
    // Paginated play function drives.
    onPageSizeChange: { control: false, table: { category: "Events" } },
  },
  args: {
    data: mockProjectRows,
    emptyMessage: "No items found.",
    pageSize: 10,
    columns,
    searchKey: "name",
    searchPlaceholder: "Search projects...",
    filterKey: "status",
    filterOptions: [
      { label: "Active", value: "Active" },
      { label: "Backlog", value: "Backlog" },
      { label: "Paused", value: "Paused" },
    ],
    sortOptions: [
      { label: "Updated (newest)", value: "updatedAt:desc" },
      { label: "Project name", value: "name:asc" },
    ],
    renderRowActions: (item: MockProjectRow) => (
      <Button
        onClick={() => action("row-action")(item)}
        size="sm"
        variant="ghost"
      >
        Open
      </Button>
    ),
    onRowClick: (item: MockProjectRow) => action("row-click")(item),
  },
} satisfies Meta<typeof ProjectDataTable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The initial sort comes from `sortOptions[0]` ("updatedAt:desc") even
    // though the dropdown owning those options never renders — so the newest
    // row leads rather than the fixture's declaration order.
    await expect(projectNamesInOrder(canvas)).toEqual([
      "Editor refresh",
      "Billing v2",
      "Mobile onboarding",
      "Usage reporting",
      "Compute target audit",
    ]);

    // Column-header sort WINS over the sort dropdown: one `sortable` column
    // sets `hasColumnSort`, which suppresses the dropdown entirely. Passing
    // both props is not additive — only the filter select survives.
    await expect(canvas.queryByLabelText("Sort")).not.toBeInTheDocument();
    await expect(canvas.getByLabelText("Filter")).toBeVisible();

    // Five rows at the default page size of 10 is a single page, so the pager
    // is absent rather than rendered-and-disabled.
    await expect(canvas.getByText("5 items total")).toBeVisible();
    await expect(
      canvas.queryByLabelText(NEXT_PAGE_LABEL)
    ).not.toBeInTheDocument();

    // A column the table is not already sorted by starts ascending, and the
    // same header reverses it on the next click.
    await userEvent.click(canvas.getByRole("button", { name: "Project" }));
    await expect(projectNamesInOrder(canvas)[0]).toBe("Billing v2");

    await userEvent.click(canvas.getByRole("button", { name: "Project" }));
    await expect(projectNamesInOrder(canvas)[0]).toBe("Usage reporting");
  },
};

export const Paginated: Story = {
  args: {
    pageSize: 2,
    pageSizeOptions: [2, 5],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const nextPage = () => canvas.getByLabelText(NEXT_PAGE_LABEL);
    const previousPage = () => canvas.getByLabelText(PREVIOUS_PAGE_LABEL);

    // First-page boundary: there is no way back.
    await expect(canvas.getByText("Page 1 of 3")).toBeVisible();
    await expect(previousPage()).toBeDisabled();
    await expect(nextPage()).toBeEnabled();
    await expect(projectNamesInOrder(canvas)).toHaveLength(2);

    await userEvent.click(nextPage());
    await expect(canvas.getByText("Page 2 of 3")).toBeVisible();
    await expect(previousPage()).toBeEnabled();
    await expect(nextPage()).toBeEnabled();

    // Last-page boundary: the trailing page carries the remainder (five rows
    // over a page size of two), and there is no way forward.
    await userEvent.click(nextPage());
    await expect(canvas.getByText("Page 3 of 3")).toBeVisible();
    await expect(nextPage()).toBeDisabled();
    await expect(projectNamesInOrder(canvas)).toHaveLength(1);

    // Growing the page size resets to page 1 — and because every row now fits
    // one page, the pager stops rendering rather than reading "Page 1 of 1".
    await userEvent.click(canvas.getByLabelText(PAGE_SIZE_LABEL));
    await userEvent.click(await screen.findByRole("option", { name: "5" }));

    await expect(projectNamesInOrder(canvas)).toHaveLength(5);
    await expect(
      canvas.queryByLabelText(NEXT_PAGE_LABEL)
    ).not.toBeInTheDocument();
  },
};

export const SingleRow: Story = {
  args: {
    data: mockProjectRows.slice(0, 1),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Singular, not "1 items total".
    await expect(canvas.getByText("1 item total")).toBeVisible();
    await expect(projectNamesInOrder(canvas)).toEqual(["Billing v2"]);
    await expect(
      canvas.queryByLabelText(NEXT_PAGE_LABEL)
    ).not.toBeInTheDocument();
  },
};

export const Empty: Story = {
  args: {
    data: [],
    emptyMessage: "No projects match these filters.",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      canvas.getByText("No projects match these filters.")
    ).toBeVisible();
    // Plural on zero, and the empty row is a message rather than a data row.
    await expect(canvas.getByText("0 items total")).toBeVisible();
    await expect(
      canvas.queryByLabelText(NEXT_PAGE_LABEL)
    ).not.toBeInTheDocument();
  },
};

export const SortDropdown: Story = {
  args: {
    columns: columns.map((column) => ({ ...column, sortable: false })),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The inverse of Default. With no sortable column `hasColumnSort` is false,
    // so the dropdown owning `sortOptions` becomes the only sort control — a
    // branch that mounts in no other story and that no current production
    // caller reaches, since neither consumer passes `sortOptions`.
    await expect(canvas.getByLabelText("Sort")).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "Project" })
    ).not.toBeInTheDocument();

    // The seeded sort still applies, now through the control a user can see.
    await expect(projectNamesInOrder(canvas)[0]).toBe("Editor refresh");
  },
};

// Reads the first cell of every body row in render order, so a play function
// can assert what sorting and pagination actually produced instead of trusting
// a count. The header row is dropped: `getAllByRole("row")` includes it.
function projectNamesInOrder(canvas: ReturnType<typeof within>): string[] {
  const [, ...bodyRows] = canvas.getAllByRole("row");
  return bodyRows.map(
    (row) => within(row).getAllByRole("cell")[0]?.textContent ?? ""
  );
}
