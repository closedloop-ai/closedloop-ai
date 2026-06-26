import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import type { Meta, StoryObj } from "@storybook/react";
import { SearchXIcon } from "lucide-react";
import { fn } from "storybook/test";

const meta = {
  title: "Design System/Primitives/Empty State",
  component: EmptyState,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: {
    description:
      "No matching sessions were found. Adjust filters or refresh the source.",
    icon: SearchXIcon,
    title: "No sessions found",
  },
  decorators: [
    (Story) => (
      <div className="w-[460px] rounded-lg border bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithAction: Story = {
  args: {
    action: (
      <Button onClick={fn()} size="sm" variant="outline">
        Clear filters
      </Button>
    ),
  },
};
