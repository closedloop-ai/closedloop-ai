import { KeyValueGrid } from "@repo/design-system/components/ui/primitives/key-value-grid";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Data Display/Key Value Grid",
  component: KeyValueGrid,
  tags: ["autodocs"],
  argTypes: {
    data: {
      control: "object",
      description:
        "Key/value pairs to render. Object and array values render as formatted JSON.",
    },
    priority: {
      control: "object",
      description: "Keys pinned to the top, in this order, ahead of the rest.",
    },
  },
  parameters: { layout: "padded" },
  args: {
    data: {
      sessionId: "sess-42",
      status: "active",
      retries: 2,
      approved: true,
      metadata: { source: "desktop", featureFlag: "agent-session-sync" },
    },
    priority: ["sessionId", "status"],
  },
} satisfies Meta<typeof KeyValueGrid>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
