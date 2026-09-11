import type { TagSummary } from "@repo/api/src/types/tag";
import { TagColor } from "@repo/api/src/types/tag";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { TagChip, TagChips } from "./tag-chip";

/**
 * A small rounded pill showing one tag's name in the color assigned to it,
 * such as red for urgent or blue for backend. Give it an onClick and it
 * becomes a clickable button; give it an onRemove instead and it grows a
 * small x for removing the tag; supply neither and it is just a label. The
 * Tag Chips list exported alongside it lays out a whole set of these and
 * collapses the overflow into a plus N chip once more tags would fit than
 * the space allows.
 */
const meta: Meta<typeof TagChip> = {
  title: "Composites/Tags/Tag Chip",
  component: TagChip,
  tags: ["autodocs"],
  argTypes: {
    tag: { control: "object" },
    size: { control: { type: "radio" }, options: ["sm", "md"] },
    onClick: {
      control: false,
      table: { category: "Events" },
      description:
        "When supplied the chip renders as a button and hides the remove control.",
    },
    onRemove: { control: false, table: { category: "Events" } },
  },
  args: { size: "sm" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const backend: TagSummary = { id: "t1", name: "backend", color: TagColor.Blue };

export const Default: Story = {
  args: { tag: backend },
};

export const Removable: Story = {
  args: {
    tag: { id: "t2", name: "urgent", color: TagColor.Red },
    onRemove: fn(),
  },
};

export const MediumSize: Story = {
  args: {
    tag: { id: "t3", name: "design", color: TagColor.Purple },
    size: "md",
  },
};

export const ChipsWithOverflow: Story = {
  args: { tag: backend },
  render: () => (
    <TagChips
      maxVisible={2}
      tags={[
        backend,
        { id: "t2", name: "urgent", color: TagColor.Red },
        { id: "t3", name: "design", color: TagColor.Purple },
        { id: "t4", name: "infra", color: TagColor.Emerald },
      ]}
    />
  ),
};
