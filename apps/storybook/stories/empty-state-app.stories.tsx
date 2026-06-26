import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import type { Meta, StoryObj } from "@storybook/react";
import { FolderSearchIcon } from "lucide-react";

const meta = {
  title: "Design System/Primitives/Empty State App Example",
  component: EmptyState,
  tags: ["autodocs"],
  args: {
    icon: FolderSearchIcon,
    title: "No related artifacts yet",
    description:
      "Attach a PRD or implementation plan to start building the relationship graph.",
    action: <Button>Create related artifact</Button>,
  },
} satisfies Meta<typeof EmptyState>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithoutAction: Story = {
  args: {
    action: undefined,
    title: "No favorites yet",
    description:
      "Pin projects or artifacts to keep important work within reach in the sidebar.",
  },
};
