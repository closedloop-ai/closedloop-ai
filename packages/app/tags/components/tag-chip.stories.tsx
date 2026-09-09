import type { TagSummary } from "@repo/api/src/types/tag";
import { TagColor } from "@repo/api/src/types/tag";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { TagChip, TagChips } from "./tag-chip";

/**
 * First shared app-core component story (FEA-1510 / AC-001.4): renders under
 * the AppCoreStoryProviders harness — no Next.js, no Clerk, no live API.
 */
const meta: Meta<typeof TagChip> = {
  title: "App Core/Tags/Tag Chip",
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
