import { CategoryBarChart } from "@repo/design-system/components/ui/category-bar-chart";
import type { Meta, StoryObj } from "@storybook/react";

const categoryData = [
  { key: "planning", label: "Planning", value: 18 },
  { key: "build", label: "Build", value: 42 },
  { key: "review", label: "Review", value: 27 },
  { key: "verify", label: "Verify", value: 14 },
];

const meta = {
  title: "Design System/Primitives/Category Bar Chart",
  component: CategoryBarChart,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: {
    data: categoryData,
  },
  decorators: [
    (Story) => (
      <div className="h-72 w-[520px] rounded-lg border bg-background p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CategoryBarChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Vertical: Story = {};

export const Horizontal: Story = {
  args: {
    horizontal: true,
  },
};

export const Empty: Story = {
  args: {
    data: [],
    emptyMessage: "No categories matched the current filters.",
  },
};
