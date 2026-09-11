import { SidebarCountBadge } from "@repo/design-system/components/ui/sidebar-count-badge";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A small round pill showing a count next to a sidebar item, capped at a max
 * like 9+ instead of crowding the pill with a large number.
 */
const meta = {
  title: "Primitives/Data Display/Sidebar Count Badge",
  component: SidebarCountBadge,
  tags: ["autodocs"],
  argTypes: {
    count: {
      control: { type: "number", min: 0, max: 999, step: 1 },
    },
    max: {
      control: { type: "number", min: 1, max: 999, step: 1 },
      description:
        "Cap above which the pill shows a capped `9+` style value instead of the raw count.",
    },
    label: {
      control: "text",
      description:
        "Accessible name so the count is announced with meaning instead of as a bare number.",
    },
    className: {
      control: "text",
    },
  },
  args: {
    count: 7,
  },
} satisfies Meta<typeof SidebarCountBadge>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/**
 * With `max`, a count above the cap renders as `<max>+` so the pill never
 * misstates the number, while an accessible `label` still announces the true
 * count.
 */
export const Capped: Story = {
  args: {
    count: 412,
    max: 9,
    label: "412 recently completed sessions",
  },
};
