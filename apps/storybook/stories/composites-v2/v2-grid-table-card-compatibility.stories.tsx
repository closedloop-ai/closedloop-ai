import { ProductGridTableV2 } from "@repo/app/shared/components/product-grid-table-v2";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  buildGridTableV2CardFields,
  GridTableV2Card,
} from "@repo/design-system/components/ui/grid-table-v2-card";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";

type Row = { id: string; name: string; status: string };

const rows: Row[] = [{ id: "first", name: "Alpha", status: "Active" }];
const noCardHeaderColumns = new Set<string>();

const withGridFlag: Decorator = (Story) => (
  <FeatureFlagAdapterProvider
    adapter={createStaticFeatureFlagAdapter({
      enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
    })}
  >
    <Story />
  </FeatureFlagAdapterProvider>
);

const meta = {
  title: "Composites/Shared/Artifact List/Grid Table Card Compatibility",
  tags: ["stable"],
  component: ProductGridTableV2<Row>,
  decorators: [withGridFlag],
  parameters: { controls: { disable: true }, layout: "fullscreen" },
} satisfies Meta<typeof ProductGridTableV2<Row>>;

export default meta;

// No controls: this fixed contract fixture isolates the opt-in card-compatibility branch; row renderers and callbacks are parent-owned.

type Story = StoryObj<typeof meta>;

export const CardCompatibility: Story = {
  args: {
    cardCompatibility: {
      alwaysActive: true,
      render: (row, columns) => (
        <GridTableV2Card
          fields={buildGridTableV2CardFields(
            columns,
            noCardHeaderColumns,
            (_columnId, item: Row) => item.status,
            row
          )}
          header={<a href={`#${row.id}`}>{row.name}</a>}
        />
      ),
    },
    columns: [{ id: "status", label: "Status" }],
    getRowId: (row) => row.id,
    gridTemplateColumns: "minmax(240px, 1fr) 160px",
    items: rows,
    leadingLabel: "Artifact",
    mode: "compact",
    renderCell: (_columnId, row) => row.status,
    renderLead: (row) => <a href={`#${row.id}`}>{row.name}</a>,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const link = canvas.getByRole("link", { name: rows[0].name });
    const card = link.closest('[data-slot="card"]');
    await expect(card).not.toBeNull();
    if (!card) {
      throw new Error("The compatibility fixture must render a card");
    }
    await expect(within(card).getByText("Status").tagName).toBe("DT");
    await expect(within(card).getByText(rows[0].status).tagName).toBe("DD");
    await expect(canvas.queryByRole("grid")).toBeNull();
    await expect(canvas.queryByRole("columnheader")).toBeNull();
    await expect(canvas.queryByRole("gridcell")).toBeNull();
  },
};
