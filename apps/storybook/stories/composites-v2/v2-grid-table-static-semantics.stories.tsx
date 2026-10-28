import { GridTableV2 } from "@repo/design-system/components/ui/grid-table-v2";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fireEvent, within } from "storybook/test";

type SessionRow = { id: string; name: string; status: string };

const rows: SessionRow[] = [
  { id: "first", name: "First session", status: "Active" },
  { id: "second", name: "Second session", status: "Inactive" },
];

const meta = {
  title: "Composites/Shared/Artifact List/Grid Table Static Semantics",
  tags: ["stable"],
  component: GridTableV2<SessionRow>,
  parameters: { controls: { disable: true }, layout: "fullscreen" },
} satisfies Meta<typeof GridTableV2<SessionRow>>;

export default meta;

// No controls: this fixed contract fixture isolates the opt-in static-table semantic branch; parent-owned slots and callbacks are not a prop surface.

type Story = StoryObj<typeof meta>;

export const StaticTableSemantics: Story = {
  args: {
    columns: [{ id: "status", label: "Status" }],
    getRowId: (row) => row.id,
    gridTemplateColumns: "minmax(240px, 1fr) 160px",
    items: rows,
    leadingLabel: "Session",
    mode: "expanded",
    renderCell: (_columnId, row) => row.status,
    renderLead: (row) => <a href={`#${row.id}`}>{row.name}</a>,
    staticTableSemantics: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const table = canvas.getByRole("table");
    await expect(canvas.queryByRole("grid")).toBeNull();

    const [header, ...body] = within(table).getAllByRole("row");
    await expect(within(header).getAllByRole("columnheader")).toHaveLength(2);
    await expect(body).toHaveLength(rows.length);
    for (const row of body) {
      await expect(within(row).getAllByRole("cell")).toHaveLength(2);
    }
    await expect(table.querySelectorAll("[data-grid-cell]")).toHaveLength(0);

    const link = canvas.getByRole("link", { name: rows[0].name });
    link.focus();
    fireEvent.keyDown(link, { key: "ArrowRight" });
    await expect(link).toHaveFocus();
  },
};
