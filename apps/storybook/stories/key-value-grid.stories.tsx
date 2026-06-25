import { KeyValueGrid } from "@repo/design-system/components/ui/primitives/key-value-grid";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Primitives/Key Value Grid",
  component: KeyValueGrid,
  tags: ["autodocs"],
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
