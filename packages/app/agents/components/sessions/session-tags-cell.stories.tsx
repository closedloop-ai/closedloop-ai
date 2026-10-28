import { ArtifactTagAvailability, TagColor } from "@repo/api/src/types/tag";
import type { Meta, StoryObj } from "@storybook/react";
import { createSessionTableRowFixture } from "./session-list-fixtures";
import { SessionTagsCell } from "./session-tags-cell";

const ROW = createSessionTableRowFixture({
  tagAvailability: ArtifactTagAvailability.Available,
  tagPermissions: { canApply: true, canRemove: true },
  tags: [{ id: "backend", name: "backend", color: TagColor.Blue }],
});

const meta = {
  title: "Composites/Artifacts/Sessions/Sessions List/Session Tags Cell",
  component: SessionTagsCell,
  tags: ["stable", "autodocs"],
  args: { row: ROW },
  argTypes: { row: { control: false } },
  parameters: { layout: "centered" },
} satisfies Meta<typeof SessionTagsCell>;

// No controls: the cell's only prop is a structured row projection, so each
// state is a named story built from the canonical fixture.
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Empty: Story = { args: { row: { ...ROW, tags: [] } } };
export const Unavailable: Story = {
  args: {
    row: { ...ROW, tagAvailability: ArtifactTagAvailability.Unavailable },
  },
};
export const ReadOnly: Story = {
  args: {
    row: { ...ROW, tagPermissions: { canApply: false, canRemove: false } },
  },
};
