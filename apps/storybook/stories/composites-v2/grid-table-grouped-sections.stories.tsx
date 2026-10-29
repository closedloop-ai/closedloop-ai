import { GridTableV2 } from "@repo/design-system/components/ui/grid-table-v2";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import { GroupedSectionsHarness } from "../grid-table-v2-grouped-sections-demo";
import { ROWS } from "../grid-table-v2-story-model";
import {
  Dark as narrowDarkStory,
  NarrowDefault as narrowDefaultStory,
  GroupedSelectable as narrowGroupedSelectableStory,
  Grouped as narrowGroupedStory,
  NestedControl as narrowNestedControlStory,
  NestedGroupsAndEmptyGroup as narrowNestedGroupsAndEmptyGroupStory,
  NestedRows as narrowNestedRowsStory,
  SelectableTree as narrowSelectableTreeStory,
  Selected as narrowSelectedStory,
} from "../support/grid-table-v2-narrow-list-stories";

const meta = {
  title: "Composites/Shared/Artifact List/Grid Table Grouped Sections",
  tags: ["stable"],
  component: GridTableV2,
  parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta<typeof GridTableV2>;

export default meta;
type Story = StoryObj;

// No controls: each fixture composition isolates one grouped-section state.
export const Default: Story = {
  render: () => <GroupedSectionsHarness initialGroupBy="status" />,
};
export const ClosedBand: Story = {
  render: () => (
    <GroupedSectionsHarness initialGroupBy="status" initiallyClosed />
  ),
};
export const RootOnlyDescendants: Story = {
  render: () => <GroupedSectionsHarness initialGroupBy="status" nestedRows />,
};
export const WindowedPopulation: Story = {
  render: () => (
    <GroupedSectionsHarness initialGroupBy="status" population="windowed" />
  ),
};
export const UnknownPopulation: Story = {
  render: () => (
    <GroupedSectionsHarness initialGroupBy="status" population="unknown" />
  ),
};
export const GroupedNarrow: Story = {
  render: () => (
    <GroupedSectionsHarness compact initialGroupBy="status" nestedRows />
  ),
  globals: { viewport: { value: "390-844" } },
};
export const NarrowDefault: Story = narrowDefaultStory;
export const Grouped: Story = narrowGroupedStory;
export const NestedGroupsAndEmptyGroup: Story =
  narrowNestedGroupsAndEmptyGroupStory;
export const NestedRows: Story = narrowNestedRowsStory;
export const Selected: Story = narrowSelectedStory;
export const NestedControl: Story = narrowNestedControlStory;
export const GroupedSelectable: Story = narrowGroupedSelectableStory;
export const SelectableTree: Story = narrowSelectableTreeStory;
export const Dark: Story = narrowDarkStory;
export const CollapseReconcilesSelection: Story = {
  render: () => <GroupedSectionsHarness initialGroupBy="status" />,
  play: async ({ canvasElement }) => {
    const first = ROWS[0];
    const second = ROWS[1];
    if (!(first && second)) {
      throw new Error("Expected two grouped selection fixtures");
    }

    await selectAdjacentRowRange(canvasElement, first.id);
    await expect(gridRow(canvasElement, first.id)).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(gridRow(canvasElement, second.id)).toHaveAttribute(
      "aria-selected",
      "true"
    );

    const toggle = groupToggle(canvasElement, first.status);
    await userEvent.click(toggle);
    await expect(
      canvasElement.querySelector(`[data-grid-row-id="${first.id}"]`)
    ).toBeNull();
    await userEvent.click(toggle);

    await expect(gridRow(canvasElement, first.id)).toHaveAttribute(
      "aria-selected",
      "false"
    );
    await expect(gridRow(canvasElement, second.id)).toHaveAttribute(
      "aria-selected",
      "true"
    );
  },
};

function gridRow(canvasElement: HTMLElement, rowId: string): HTMLElement {
  const row = canvasElement.querySelector<HTMLElement>(
    `[data-grid-row-id="${rowId}"]`
  );
  if (!row) {
    throw new Error(`Expected grid row ${rowId}`);
  }
  return row;
}

function groupToggle(canvasElement: HTMLElement, label: string): HTMLElement {
  return within(canvasElement).getByRole("button", {
    name: new RegExp(label),
  });
}

async function selectAdjacentRowRange(
  canvasElement: HTMLElement,
  firstRowId: string
): Promise<void> {
  await userEvent.click(rowCell(canvasElement, firstRowId));
  await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
}

function rowCell(canvasElement: HTMLElement, rowId: string): HTMLElement {
  const cell = gridRow(canvasElement, rowId).querySelector<HTMLElement>(
    '[data-column-id="status"]'
  );
  if (!cell) {
    throw new Error(`Expected selectable cell for ${rowId}`);
  }
  return cell;
}
