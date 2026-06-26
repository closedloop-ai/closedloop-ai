import { SidebarCountBadge } from "@repo/design-system/components/ui/sidebar-count-badge";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Primitives/Sidebar Count Badge",
  component: SidebarCountBadge,
  tags: ["autodocs"],
  args: {
    count: 7,
  },
} satisfies Meta<typeof SidebarCountBadge>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
